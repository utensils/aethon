// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVoiceConversation } from "./useVoiceConversation";
import { emitAgentTurnComplete } from "../utils/agentTurnEvents";
import { isConversationActive } from "../utils/conversationMode";

const { mocks, ev } = vi.hoisted(() => ({
  ev: {
    fn: undefined as undefined | (() => void),
    level: undefined as undefined | ((e: { payload: { level: number } }) => void),
  },
  mocks: {
    startVoiceRecording: vi.fn(() => Promise.resolve()),
    stopAndTranscribeVoice: vi.fn(() => Promise.resolve("hello agent")),
    speakVoice: vi.fn(() => Promise.resolve()),
    cancelVoiceRecording: vi.fn(() => Promise.resolve()),
    stopVoicePlayback: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../services/voice", () => ({
  startVoiceRecording: mocks.startVoiceRecording,
  stopAndTranscribeVoice: mocks.stopAndTranscribeVoice,
  speakVoice: mocks.speakVoice,
  cancelVoiceRecording: mocks.cancelVoiceRecording,
  stopVoicePlayback: mocks.stopVoicePlayback,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: { level: number } }) => void) => {
    if (name === "voice://playback-finished") ev.fn = () => cb({ payload: { level: 0 } });
    if (name === "voice://level") ev.level = cb;
    return Promise.resolve(() => {});
  },
}));

/** Flush pending microtasks created by the hook's async transitions. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeController(continuous = false) {
  const submitText = vi.fn();
  const { result, unmount } = renderHook(() =>
    useVoiceConversation({
      submitText,
      getActiveTabId: () => "t1",
      continuous,
      maxSpokenChars: 600,
      // These tests exercise the LFM2 loop specifically; "auto" would probe
      // cascade availability over IPC at enter time.
      engine: "lfm2",
    }),
  );
  return { result, submitText, unmount };
}

describe("useVoiceConversation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockClear());
    mocks.startVoiceRecording.mockResolvedValue(undefined);
    mocks.stopAndTranscribeVoice.mockResolvedValue("hello agent");
    ev.fn = undefined;
    ev.level = undefined;
  });
  afterEach(() => cleanup());

  it("runs a full turn: tap → listen → transcribe → submit → speak → idle", async () => {
    const { result, submitText } = makeController(false);

    // Auto off: entering lands paused, not recording.
    act(() => result.current.enter());
    await flush();
    expect(mocks.startVoiceRecording).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(isConversationActive()).toBe(true);

    // Tap "Speak" to open the mic for the first turn.
    act(() => result.current.primaryAction());
    await flush();
    expect(mocks.startVoiceRecording).toHaveBeenCalledWith(
      "voice-lfm2-audio-llamacpp",
    );
    expect(result.current.phase).toBe("listening");

    act(() => result.current.primaryAction());
    await flush();
    expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
    expect(submitText).toHaveBeenCalledWith("hello agent");
    expect(result.current.phase).toBe("thinking");

    act(() => emitAgentTurnComplete({ tabId: "t1", text: "The reply." }));
    await flush();
    expect(mocks.speakVoice).toHaveBeenCalledWith("The reply.");
    expect(result.current.phase).toBe("speaking");

    act(() => ev.fn?.());
    await flush();
    expect(result.current.phase).toBe("idle");
  });

  it("does not open the mic on entry when auto-listen is off", async () => {
    const { result } = makeController(false);

    act(() => result.current.enter());
    await flush();

    expect(mocks.startVoiceRecording).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.active).toBe(true);
  });

  it("opens the mic immediately on entry when auto-listen is on", async () => {
    const { result } = makeController(true);

    act(() => result.current.enter());
    await flush();

    expect(mocks.startVoiceRecording).toHaveBeenCalledWith(
      "voice-lfm2-audio-llamacpp",
    );
    expect(result.current.phase).toBe("listening");
  });

  it("re-opens the mic after speaking in continuous mode", async () => {
    const { result } = makeController(true);
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction());
    await flush();
    act(() => emitAgentTurnComplete({ tabId: "t1", text: "Reply." }));
    await flush();
    mocks.startVoiceRecording.mockClear();

    act(() => ev.fn?.());
    await flush();
    expect(mocks.startVoiceRecording).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("listening");
  });

  it("auto-ends the utterance on silence (hands-free, no tap)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1000);
      const { result, submitText } = makeController(true);
      act(() => result.current.enter());
      await flush();
      expect(result.current.phase).toBe("listening");

      // The user speaks...
      act(() => ev.level?.({ payload: { level: 0.12 } }));
      // ...then goes quiet for longer than the silence-hang window.
      vi.setSystemTime(1000 + 1500);
      act(() => ev.level?.({ payload: { level: 0.0 } }));
      await flush();

      // VAD finished the turn without any manual "done" action.
      expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
      expect(submitText).toHaveBeenCalledWith("hello agent");
      expect(result.current.phase).toBe("thinking");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-end before the user has spoken", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1000);
      const { result } = makeController(true);
      act(() => result.current.enter());
      await flush();

      // Pure silence (no speech yet) must not end the turn, no matter how long.
      vi.setSystemTime(1000 + 5000);
      act(() => ev.level?.({ payload: { level: 0.0 } }));
      await flush();
      expect(mocks.stopAndTranscribeVoice).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("listening");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a turn-complete for a different tab", async () => {
    const { result } = makeController(false);
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction()); // tap to start listening
    await flush();
    act(() => result.current.primaryAction()); // finish → submit → thinking
    await flush();

    act(() => emitAgentTurnComplete({ tabId: "other", text: "Not mine." }));
    await flush();
    expect(mocks.speakVoice).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("thinking");
  });

  it("does not submit an empty transcript", async () => {
    const { result, submitText } = makeController(false);
    mocks.stopAndTranscribeVoice.mockResolvedValueOnce("   ");
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction()); // tap to start listening
    await flush();
    act(() => result.current.primaryAction()); // finish → empty → idle
    await flush();
    expect(submitText).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("ignores a second start while the first is still opening the mic", async () => {
    let resolveStart: () => void = () => {};
    mocks.startVoiceRecording.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { result } = makeController(false);

    act(() => result.current.enter()); // paused (Auto off)
    act(() => result.current.primaryAction()); // first start — hangs in the open window
    act(() => result.current.primaryAction()); // second tap during the window
    expect(mocks.startVoiceRecording).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStart();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("listening");
  });

  it("exit cancels recording/playback and clears the active flag", async () => {
    const { result } = makeController(false);
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction()); // tap to start listening
    await flush();

    act(() => result.current.exit());
    await flush();
    expect(mocks.cancelVoiceRecording).toHaveBeenCalled();
    expect(mocks.stopVoicePlayback).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(isConversationActive()).toBe(false);
  });

  it("push-to-talk hold keeps the mic open through silence until release", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1000);
      const { result, submitText } = makeController(true);
      act(() => result.current.enter());
      await flush();
      expect(result.current.phase).toBe("listening");

      // The user presses and holds the push-to-talk key.
      act(() => result.current.beginHold());

      // They speak, then pause well past the silence-hang window — VAD must NOT
      // end the utterance because the key is held.
      act(() => ev.level?.({ payload: { level: 0.12 } }));
      vi.setSystemTime(1000 + 5000);
      act(() => ev.level?.({ payload: { level: 0.0 } }));
      await flush();
      expect(mocks.stopAndTranscribeVoice).not.toHaveBeenCalled();
      expect(result.current.phase).toBe("listening");

      // Releasing ends the utterance and sends it.
      act(() => result.current.endHold());
      await flush();
      expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
      expect(submitText).toHaveBeenCalledWith("hello agent");
      expect(result.current.phase).toBe("thinking");
    } finally {
      vi.useRealTimers();
    }
  });

  it("push-to-talk from an idle turn re-opens the mic", async () => {
    const { result } = makeController(false);
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction()); // tap to start listening
    await flush();
    act(() => result.current.primaryAction()); // finish → submit → thinking
    await flush();
    // An empty reply drops a non-continuous conversation back to idle.
    act(() => emitAgentTurnComplete({ tabId: "t1", text: "" }));
    await flush();
    expect(result.current.phase).toBe("idle");

    mocks.startVoiceRecording.mockClear();
    act(() => result.current.beginHold());
    await flush();
    expect(mocks.startVoiceRecording).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("listening");
  });

  it("a release before the mic opens does not strand it recording", async () => {
    const { result } = makeController(false);
    // Drive one turn so the conversation settles back to idle.
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction()); // tap to start listening
    await flush();
    act(() => result.current.primaryAction()); // finish → thinking
    await flush();
    act(() => emitAgentTurnComplete({ tabId: "t1", text: "" }));
    await flush();
    expect(result.current.phase).toBe("idle");

    // The next open hangs so we can release while it is still in flight.
    let resolveStart: () => void = () => {};
    mocks.startVoiceRecording.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    mocks.stopAndTranscribeVoice.mockClear();
    mocks.stopAndTranscribeVoice.mockResolvedValueOnce("");

    act(() => result.current.beginHold()); // idle → start (hanging)
    act(() => result.current.endHold()); // released before the recorder is ready

    await act(async () => {
      resolveStart();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The deferred open immediately finishes — the mic never stays "listening"
    // with no keyup left to close it.
    expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
    expect(result.current.phase).not.toBe("listening");
  });

  it("ends a held utterance when focus is lost (no stuck mic)", async () => {
    const { result } = makeController(true);
    act(() => result.current.enter());
    await flush();
    expect(result.current.phase).toBe("listening");

    // Holding push-to-talk (VAD suppressed), but the user never spoke.
    act(() => result.current.beginHold());

    // Focus leaves before any speech — the lost keyup must not wedge the mic.
    act(() => window.dispatchEvent(new Event("blur")));
    await flush();

    expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
    expect(result.current.phase).not.toBe("listening");
  });

  it("a release without a held press never sends", async () => {
    const { result, submitText } = makeController(true);
    act(() => result.current.enter());
    await flush();
    expect(result.current.phase).toBe("listening");

    act(() => result.current.endHold());
    await flush();
    expect(mocks.stopAndTranscribeVoice).not.toHaveBeenCalled();
    expect(submitText).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("listening");
  });

  it("push-to-talk is inert when no conversation is active", async () => {
    const { result } = makeController(false);
    act(() => result.current.beginHold());
    await flush();
    expect(mocks.startVoiceRecording).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });
});
