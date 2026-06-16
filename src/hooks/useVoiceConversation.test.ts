// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVoiceConversation } from "./useVoiceConversation";
import { emitAgentTurnComplete } from "../utils/agentTurnEvents";
import { isConversationActive } from "../utils/conversationMode";

const { mocks, playback } = vi.hoisted(() => ({
  playback: { fn: undefined as undefined | (() => void) },
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
  listen: (name: string, cb: () => void) => {
    if (name === "voice://playback-finished") playback.fn = cb;
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
    }),
  );
  return { result, submitText, unmount };
}

describe("useVoiceConversation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockClear());
    mocks.startVoiceRecording.mockResolvedValue(undefined);
    mocks.stopAndTranscribeVoice.mockResolvedValue("hello agent");
    playback.fn = undefined;
  });
  afterEach(() => cleanup());

  it("runs a full turn: listen → transcribe → submit → speak → idle", async () => {
    const { result, submitText } = makeController(false);

    act(() => result.current.enter());
    await flush();
    expect(mocks.startVoiceRecording).toHaveBeenCalledWith(
      "voice-lfm2-audio-llamacpp",
    );
    expect(result.current.phase).toBe("listening");
    expect(isConversationActive()).toBe(true);

    act(() => result.current.primaryAction());
    await flush();
    expect(mocks.stopAndTranscribeVoice).toHaveBeenCalled();
    expect(submitText).toHaveBeenCalledWith("hello agent");
    expect(result.current.phase).toBe("thinking");

    act(() => emitAgentTurnComplete({ tabId: "t1", text: "The reply." }));
    await flush();
    expect(mocks.speakVoice).toHaveBeenCalledWith("The reply.");
    expect(result.current.phase).toBe("speaking");

    act(() => playback.fn?.());
    await flush();
    expect(result.current.phase).toBe("idle");
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

    act(() => playback.fn?.());
    await flush();
    expect(mocks.startVoiceRecording).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("listening");
  });

  it("ignores a turn-complete for a different tab", async () => {
    const { result } = makeController(false);
    act(() => result.current.enter());
    await flush();
    act(() => result.current.primaryAction());
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
    act(() => result.current.primaryAction());
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

    act(() => result.current.enter()); // first start — hangs in the open window
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

    act(() => result.current.exit());
    await flush();
    expect(mocks.cancelVoiceRecording).toHaveBeenCalled();
    expect(mocks.stopVoicePlayback).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(isConversationActive()).toBe(false);
  });
});
