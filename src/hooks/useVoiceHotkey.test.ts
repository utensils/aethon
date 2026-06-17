// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createVoiceHotkeyHandlers,
  formatHoldHotkey,
  formatToggleHotkey,
  matchesToggle,
} from "./useVoiceHotkey";
import type { VoiceInputController } from "./useVoiceInput";

// A Mock is structurally assignable to the handle's `() => void` methods, so
// inference gives us both a valid ConversationHotkeyHandle and spies to assert.
function conversation(active: boolean) {
  return { active, beginHold: vi.fn(), endHold: vi.fn() };
}

const altRightDown = {
  key: "Alt",
  code: "AltRight",
  metaKey: false,
  shiftKey: false,
  altKey: true,
} as const;
const altRightUp = { ...altRightDown, altKey: false } as const;

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "m",
    code: "KeyM",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function voice(state: VoiceInputController["state"]): VoiceInputController {
  return {
    state,
    elapsedSeconds: 0,
    interimTranscript: "",
    error: null,
    activeProvider: null,
    webSpeechSupported: false,
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("voice hotkeys", () => {
  it("matches the default toggle combo exactly", () => {
    expect(matchesToggle(keyEvent({}), "mod+shift+m")).toBe(true);
    expect(matchesToggle(keyEvent({ shiftKey: false }), "mod+shift+m")).toBe(
      false,
    );
    expect(matchesToggle(keyEvent({ altKey: true }), "mod+shift+m")).toBe(
      false,
    );
  });

  it("formats toggle and hold bindings for settings labels", () => {
    expect(formatToggleHotkey("mod+shift+m", true)).toBe("⌘⇧M");
    expect(formatToggleHotkey("mod+shift+m", false)).toBe("Ctrl+Shift+M");
    expect(formatHoldHotkey("AltRight", true)).toBe("Right ⌥");
  });

  it("toggle starts from idle, stops from recording, and cancels in-flight states", () => {
    const idle = voice("idle");
    const idleHandlers = createVoiceHotkeyHandlers(
      () => idle,
      "mod+shift+m",
      null,
    );
    idleHandlers.onKeyDown(keyEvent({}));
    expect(idle.start).toHaveBeenCalledTimes(1);

    const recording = voice("recording");
    const recordingHandlers = createVoiceHotkeyHandlers(
      () => recording,
      "mod+shift+m",
      null,
    );
    recordingHandlers.onKeyDown(keyEvent({}));
    expect(recording.stop).toHaveBeenCalledTimes(1);

    const starting = voice("starting");
    const startingHandlers = createVoiceHotkeyHandlers(
      () => starting,
      "mod+shift+m",
      null,
    );
    startingHandlers.onKeyDown(keyEvent({}));
    expect(starting.cancel).toHaveBeenCalledTimes(1);
  });

  it("hold-to-talk starts (auto-send) on keydown and stops on keyup", () => {
    const current = voice("idle");
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      null,
      "code:AltRight",
    );

    handlers.onKeyDown(keyEvent(altRightDown));
    expect(current.start).toHaveBeenCalledTimes(1);
    // Release after a hold must submit, not just insert into the composer.
    expect(current.start).toHaveBeenCalledWith({ autoSend: true });

    current.state = "recording";
    handlers.onKeyUp(keyEvent(altRightUp));
    expect(current.stop).toHaveBeenCalledTimes(1);
  });

  it("routes the hold key to conversation push-to-talk when a conversation is active", () => {
    const current = voice("idle");
    const convo = conversation(true);
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      "mod+shift+m",
      "code:AltRight",
      () => false,
      () => convo,
    );

    handlers.onKeyDown(keyEvent(altRightDown));
    expect(convo.beginHold).toHaveBeenCalledTimes(1);
    expect(current.start).not.toHaveBeenCalled();

    handlers.onKeyUp(keyEvent(altRightUp));
    expect(convo.endHold).toHaveBeenCalledTimes(1);
    expect(current.stop).not.toHaveBeenCalled();
  });

  it("ends the same subsystem the press started even if the conversation flips before release", () => {
    const current = voice("idle");
    let active = true;
    const convo = conversation(true);
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      null,
      "code:AltRight",
      () => false,
      () => ({ ...convo, active }),
    );

    handlers.onKeyDown(keyEvent(altRightDown));
    expect(convo.beginHold).toHaveBeenCalledTimes(1);

    // Conversation ends mid-hold; the release must still go to endHold, not stop.
    active = false;
    handlers.onKeyUp(keyEvent(altRightUp));
    expect(convo.endHold).toHaveBeenCalledTimes(1);
    expect(current.stop).not.toHaveBeenCalled();
  });

  it("suppresses the dictation toggle while a conversation owns the mic", () => {
    const current = voice("idle");
    const convo = conversation(true);
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      "mod+shift+m",
      null,
      () => false,
      () => convo,
    );

    handlers.onKeyDown(keyEvent({}));
    expect(current.start).not.toHaveBeenCalled();
    expect(convo.beginHold).not.toHaveBeenCalled();
  });

  it("keeps the toggle as a mic-off escape hatch for live dictation under a conversation", () => {
    // A dictation recording already running when the HUD opens must stay
    // stoppable — only the idle start path is suppressed.
    const recording = voice("recording");
    const stopHandlers = createVoiceHotkeyHandlers(
      () => recording,
      "mod+shift+m",
      null,
      () => false,
      () => conversation(true),
    );
    stopHandlers.onKeyDown(keyEvent({}));
    expect(recording.stop).toHaveBeenCalledTimes(1);

    const transcribing = voice("transcribing");
    const cancelHandlers = createVoiceHotkeyHandlers(
      () => transcribing,
      "mod+shift+m",
      null,
      () => false,
      () => conversation(true),
    );
    cancelHandlers.onKeyDown(keyEvent({}));
    expect(transcribing.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not start while input is blocked", () => {
    const current = voice("idle");
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      "mod+shift+m",
      "code:AltRight",
      () => true,
    );

    handlers.onKeyDown(keyEvent({}));
    handlers.onKeyDown(
      keyEvent({
        key: "Alt",
        code: "AltRight",
        metaKey: false,
        shiftKey: false,
        altKey: true,
      }),
    );

    expect(current.start).not.toHaveBeenCalled();
  });
});
