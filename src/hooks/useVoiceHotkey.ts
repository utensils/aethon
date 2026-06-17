import { useEffect, useLayoutEffect, useRef } from "react";
import type { VoiceInputController } from "./useVoiceInput";
import type { VoiceConversationController } from "./useVoiceConversation";

/** The slice of the conversation controller the hold hotkey drives. When a
 * conversation is active the hold key is its push-to-talk: press suppresses
 * VAD, release ends the utterance — so the same key never also fires dictation. */
export type ConversationHotkeyHandle = Pick<
  VoiceConversationController,
  "active" | "beginHold" | "endHold"
>;

// Re-export so existing call sites (KeyboardSettings, tests) keep working.
export {
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_HOLD_HOTKEY_MAC,
  getDefaultHoldHotkey,
} from "../utils/voiceHotkeys";

/** Detect AltGr — Right Alt on most non-US layouts produces this and is used
 * to type common characters. We must never treat AltGr presses as hotkey
 * activations. */
function isAltGr(e: KeyboardEvent): boolean {
  if (e.key === "AltGraph") return true;
  // Some browsers/OSes report AltGr as Ctrl+Alt with code AltRight.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return true;
  return e.code === "AltRight" && e.ctrlKey && e.altKey;
}

type VoiceHandle = Pick<VoiceInputController, "state" | "start" | "stop" | "cancel">;

/** Normalize a key name for use in the `+`-delimited combo format.
 * "+" itself becomes "plus" so the serialized combo stays unambiguous
 * (otherwise "mod+shift+" + "+" would split into a stray empty segment). */
export function normalizeToggleKey(key: string): string {
  if (key === "+") return "plus";
  return key.toLowerCase();
}

/** Check if a keyboard event matches a stored toggle combo like "mod+shift+m". */
export function matchesToggle(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key || normalizeToggleKey(e.key) !== key) return false;
  const wantsMod = parts.includes("mod");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt");
  const hasMod = e.metaKey || e.ctrlKey;
  return wantsMod === hasMod && wantsShift === e.shiftKey && wantsAlt === e.altKey;
}

/** Human-readable display of a toggle hotkey string (e.g. "mod+shift+m" → "⌘⇧M"). */
export function formatToggleHotkey(hotkey: string | null, isMac: boolean): string {
  if (!hotkey) return "—";
  return hotkey
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      if (part === "shift") return isMac ? "⇧" : "Shift";
      if (part === "alt") return isMac ? "⌥" : "Alt";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac ? "" : "+");
}

const HOLD_KEY_DISPLAY: Record<string, { mac: string; other: string }> = {
  AltRight: { mac: "Right ⌥", other: "Right Alt" },
  AltLeft: { mac: "Left ⌥", other: "Left Alt" },
  ControlRight: { mac: "Right ⌃", other: "Right Ctrl" },
  ControlLeft: { mac: "Left ⌃", other: "Left Ctrl" },
  ShiftRight: { mac: "Right ⇧", other: "Right Shift" },
  ShiftLeft: { mac: "Left ⇧", other: "Left Shift" },
  MetaRight: { mac: "Right ⌘", other: "Right Meta" },
  MetaLeft: { mac: "Left ⌘", other: "Left Meta" },
  Space: { mac: "Space", other: "Space" },
  F13: { mac: "F13", other: "F13" },
  F14: { mac: "F14", other: "F14" },
  F15: { mac: "F15", other: "F15" },
};

/** Human-readable display of a hold key code (e.g. "AltRight" → "Right ⌥"). */
export function formatHoldHotkey(code: string | null, isMac: boolean): string {
  if (!code) return "—";
  const entry = HOLD_KEY_DISPLAY[code];
  if (entry) return isMac ? entry.mac : entry.other;
  return code.replace(/^(?:Key|Digit)/, "");
}

/**
 * Factory that produces the raw event handlers for the voice hotkey state machine.
 * Exported so tests can exercise the logic without mounting a React component.
 *
 * The hold-to-talk state is tracked in a closure variable shared across the
 * three returned handlers, so they must all be created together and used as a set.
 */
export function createVoiceHotkeyHandlers(
  getVoice: () => VoiceHandle,
  toggleHotkey: string | null,
  holdBinding: string | null,
  /** Returns true when the hotkey should not fire START actions (e.g. a modal
   * or settings panel is open). Stop/cancel/release actions still run so an
   * in-flight recording can always be ended. */
  isInputBlocked: () => boolean = () => false,
  /** When a voice conversation is active, the hold key is its push-to-talk
   * instead of a dictation trigger. Null/absent → dictation only. */
  getConversation: () => ConversationHotkeyHandle | null = () => null,
): {
  onKeyDown: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
} {
  let holdActive = false;
  // Which subsystem the current hold drives, captured at keydown so the matching
  // keyup ends the same one even if the conversation flips mid-press.
  let holdTarget: "voice" | "conversation" | null = null;
  const holdCode = holdBindingToCode(holdBinding);

  return {
    onKeyDown(e: KeyboardEvent) {
      // Suppress repeated keydowns. Toggle and hold-to-talk both fire once per
      // physical press, so OS key-repeat events should be eaten — otherwise
      // a printable toggle binding (e.g. user rebinds to a single letter)
      // would leak repeated characters into the focused input on hold.
      if (e.repeat) {
        if (holdCode && e.code === holdCode && holdActive) e.preventDefault();
        if (toggleHotkey && matchesToggle(e, toggleHotkey)) e.preventDefault();
        return;
      }

      const v = getVoice();

      if (toggleHotkey && matchesToggle(e, toggleHotkey)) {
        e.preventDefault();
        // A live conversation owns the mic; don't let the dictation toggle
        // open a second recording on the same device.
        if (getConversation()?.active) return;
        if (v.state === "recording") {
          v.stop();
        } else if (v.state === "starting" || v.state === "transcribing") {
          v.cancel();
        } else if (!isInputBlocked()) {
          // idle, setup-required, or error — try start (only when no overlay
          // owns input focus). Mirrors the mic button's catchall: from
          // setup-required, start() re-runs the provider check (now
          // succeeding after the user granted perms); from error it clears
          // the error and re-attempts.
          void v.start();
        }
        return;
      }

      // Reject AltGr presses outright — Right Alt acts as AltGr on most
      // non-US layouts and is used to type @, {}, ñ, ç, etc. Triggering
      // hold-to-talk on those would break normal text entry.
      if (holdCode && e.code === holdCode && isAltGr(e)) return;

      if (
        holdBinding &&
        holdBindingMatchesEvent(holdBinding, e) &&
        !holdActive &&
        !isInputBlocked()
      ) {
        // Conversation push-to-talk takes precedence: the held key suppresses
        // VAD and the release sends, rather than starting a dictation pass.
        const conversation = getConversation();
        if (conversation?.active) {
          e.preventDefault();
          holdActive = true;
          holdTarget = "conversation";
          conversation.beginHold();
          return;
        }
        // Dictation: hold to record, release auto-sends (push-to-talk). Only
        // start from a settled state so a release/timeout mid-press is clean.
        if (
          v.state !== "recording" &&
          v.state !== "starting" &&
          v.state !== "transcribing"
        ) {
          e.preventDefault();
          holdActive = true;
          holdTarget = "voice";
          void v.start({ autoSend: true });
        }
      }
    },

    onKeyUp(e: KeyboardEvent) {
      if (!holdCode || !holdActive || e.code !== holdCode) return;
      holdActive = false;
      const target = holdTarget;
      holdTarget = null;
      if (target === "conversation") {
        getConversation()?.endHold();
        return;
      }
      const v = getVoice();
      if (v.state === "recording" || v.state === "starting") {
        v.stop();
      }
    },

    // Window blur (e.g. Cmd+Tab away while holding the key): clear the
    // hold-state flag so a stale keyup arriving later is a no-op. The
    // actual recording stop is handled centrally by useVoiceInput so it
    // applies regardless of how the recording was started (mic button,
    // toggle hotkey, hold-to-talk).
    onBlur() {
      holdActive = false;
      holdTarget = null;
    },
  };
}

/**
 * Registers global keyboard shortcuts for voice input:
 * - Toggle hotkey (default Cmd/Ctrl+Shift+M): start/stop recording.
 * - Hold hotkey (default Right Alt/Option): hold to record, release to transcribe.
 *
 * Listeners are re-registered only when the hotkey config changes, not on
 * every voice state update (voice state is read via a ref at handler time).
 */
export function useVoiceHotkey(
  voice: VoiceInputController,
  toggleHotkey: string | null,
  holdHotkey: string | null,
  isInputBlocked: () => boolean = () => false,
  conversation?: ConversationHotkeyHandle | null,
): void {
  const voiceRef = useRef<VoiceInputController>(voice);
  const conversationRef = useRef<ConversationHotkeyHandle | null>(
    conversation ?? null,
  );

  // Keep the refs in sync after every render so event handlers always read
  // the latest voice/conversation state without being re-registered on every
  // state change. useLayoutEffect (not render-time assignment) satisfies the
  // React Compiler's requirement that refs are only mutated outside of render.
  useLayoutEffect(() => {
    voiceRef.current = voice;
    conversationRef.current = conversation ?? null;
  });

  useEffect(() => {
    const toggleBinding = toggleHotkey;
    const holdBinding = holdHotkey ? `code:${holdHotkey}` : null;
    const { onKeyDown, onKeyUp, onBlur } = createVoiceHotkeyHandlers(
      () => voiceRef.current,
      toggleBinding,
      holdBinding,
      isInputBlocked,
      () => conversationRef.current,
    );
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [toggleHotkey, holdHotkey, isInputBlocked]);
}

function holdBindingMatchesEvent(binding: string, e: KeyboardEvent): boolean {
  if (binding.startsWith("code:")) {
    return e.code === binding.slice("code:".length);
  }
  if (binding.includes("+")) {
    const parts = binding.toLowerCase().split("+");
    const key = parts.at(-1);
    if (!key) return false;
    return (
      normalizeToggleKey(e.key) === key &&
      parts.includes("mod") === (e.metaKey || e.ctrlKey) &&
      parts.includes("shift") === e.shiftKey &&
      parts.includes("alt") === e.altKey
    );
  }
  return e.code === binding;
}

function holdBindingToCode(binding: string | null): string | null {
  if (!binding) return null;
  const finalPart = binding.split("+").at(-1);
  if (!finalPart) return null;
  return finalPart.startsWith("code:") ? finalPart.slice("code:".length) : finalPart;
}
