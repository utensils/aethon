import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ConversationHotkeyHandle } from "../../hooks/useVoiceHotkey";
import { useVoiceHotkey } from "../../hooks/useVoiceHotkey";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { insertTranscriptAtSelection, shouldOpenVoiceSettingsForError } from "../../utils/voice";
import { isVoiceSurfaceBlocked, restoreTextareaCursor } from "./textarea-input-semantics";

export interface TextareaVoiceInputConfig {
  toggleHotkey?: string | null;
  holdHotkey?: string | null;
}

export interface TextareaVoiceInputOverlayState {
  settingsOpen?: boolean;
  paletteOpen?: boolean;
  searchOpen?: boolean;
}

export function useTextareaVoiceInput({
  value,
  setValue,
  onValueCommit,
  setCursor,
  textareaRef,
  surfaceActive,
  disabled = false,
  overlays,
  voiceConfig,
  onNeedsSetup,
  onAutoSend,
  conversation,
}: {
  value: string;
  setValue: (value: string) => void;
  onValueCommit?: (value: string) => void;
  setCursor?: (cursor: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  surfaceActive: boolean;
  disabled?: boolean;
  overlays?: TextareaVoiceInputOverlayState;
  voiceConfig: TextareaVoiceInputConfig;
  onNeedsSetup: (providerId: string) => void;
  onAutoSend: (text: string) => void;
  conversation?: ConversationHotkeyHandle;
}) {
  const handleTranscript = useCallback(
    (transcript: string, options?: { autoSend?: boolean }) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? value.length;
      const end = textarea?.selectionEnd ?? value.length;
      const next = insertTranscriptAtSelection(
        textarea?.value ?? value,
        transcript,
        start,
        end,
      );
      setValue(next.text);
      onValueCommit?.(next.text);
      setCursor?.(next.cursor);
      if (options?.autoSend && next.text.trim().length > 0) {
        onAutoSend(next.text);
        return;
      }
      restoreTextareaCursor(textareaRef, next.cursor);
    },
    [onAutoSend, onValueCommit, setCursor, setValue, textareaRef, value],
  );

  const voice = useVoiceInput(handleTranscript, onNeedsSetup, { surfaceActive });
  const voiceInputBlocked = isVoiceSurfaceBlocked({
    surfaceActive,
    disabled,
    settingsOpen: overlays?.settingsOpen,
    paletteOpen: overlays?.paletteOpen,
    searchOpen: overlays?.searchOpen,
  });
  const voiceInputBlockedRef = useRef(voiceInputBlocked);
  useLayoutEffect(() => {
    voiceInputBlockedRef.current = voiceInputBlocked;
  }, [voiceInputBlocked]);
  const isVoiceInputBlocked = useCallback(
    () => voiceInputBlockedRef.current,
    [],
  );
  useVoiceHotkey(
    voice,
    voiceConfig.toggleHotkey ?? "mod+shift+m",
    voiceConfig.holdHotkey ?? null,
    isVoiceInputBlocked,
    conversation,
  );

  const voiceState = voice.state;
  const cancelVoice = voice.cancel;
  useEffect(() => {
    if (voiceState !== "recording") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoice();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [voiceState, cancelVoice]);

  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return {
    voice,
    useDynamicMeter: !reducedMotion && voice.activeProvider?.recordingMode === "native",
    voiceErrorOpensSettings: shouldOpenVoiceSettingsForError(voice.activeProvider),
    voiceInputBlocked,
  };
}
