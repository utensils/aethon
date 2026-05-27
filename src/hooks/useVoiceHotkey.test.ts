// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createVoiceHotkeyHandlers,
  formatHoldHotkey,
  formatToggleHotkey,
  matchesToggle,
} from "./useVoiceHotkey";
import type { VoiceInputController } from "./useVoiceInput";

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

  it("hold-to-talk starts on keydown and stops on keyup", () => {
    const current = voice("idle");
    const handlers = createVoiceHotkeyHandlers(
      () => current,
      null,
      "code:AltRight",
    );

    handlers.onKeyDown(
      keyEvent({
        key: "Alt",
        code: "AltRight",
        metaKey: false,
        shiftKey: false,
        altKey: true,
      }),
    );
    expect(current.start).toHaveBeenCalledTimes(1);

    current.state = "recording";
    handlers.onKeyUp(
      keyEvent({
        key: "Alt",
        code: "AltRight",
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    );
    expect(current.stop).toHaveBeenCalledTimes(1);
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
