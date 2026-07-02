// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCascadeConversation } from "./useCascadeConversation";
import { emitAgentTurnComplete } from "../utils/agentTurnEvents";
import {
  emitVoiceBrainDelta,
  emitVoiceBrainEnd,
  emitVoiceBrainError,
} from "../utils/voiceBrainEvents";
import { isConversationActive } from "../utils/conversationMode";

const { mocks, ev } = vi.hoisted(() => ({
  ev: {
    listeners: new Map<string, (e: { payload: unknown }) => void>(),
  },
  mocks: {
    startVoiceConvo: vi.fn(() => Promise.resolve()),
    stopVoiceConvo: vi.fn(() => Promise.resolve()),
    speakConvoChunk: vi.fn(() => Promise.resolve()),
    endConvoSpeech: vi.fn(() => Promise.resolve()),
    cancelConvoSpeech: vi.fn(() => Promise.resolve()),
    forceConvoEndTurn: vi.fn(() => Promise.resolve()),
    sendVoiceBridgeMessage: vi.fn(),
    voiceConvoStatus: vi.fn(() =>
      Promise.resolve({ available: true, state: "idle" }),
    ),
  },
}));

vi.mock("../services/voiceConvo", () => mocks);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    ev.listeners.set(name, cb);
    return Promise.resolve(() => {});
  },
}));

function fire(event: string, payload: unknown) {
  ev.listeners.get(event)?.({ payload });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeController() {
  const submitTranscript = vi.fn();
  const { result, unmount } = renderHook(() =>
    useCascadeConversation({
      getContext: () => ({
        activeTabId: "t1",
        projectPath: "/repo",
        defaultModel: "anthropic/claude-x",
      }),
      submitTranscript,
      getActiveTabId: () => "t1",
    }),
  );
  return { result, unmount, submitTranscript };
}

describe("useCascadeConversation", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => {
      if ("mockClear" in mock) mock.mockClear();
    });
    mocks.startVoiceConvo.mockResolvedValue(undefined);
    ev.listeners.clear();
  });
  afterEach(() => cleanup());

  it("enter starts the engine; a turn goes straight to the work agent", async () => {
    const { result, submitTranscript } = makeController();
    act(() => result.current.enter());
    await flush();
    expect(mocks.startVoiceConvo).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("listening");
    expect(isConversationActive()).toBe(true);

    act(() => {
      fire("voice://convo/interim", { text: "fix the fl" });
    });
    expect(result.current.interimText).toBe("fix the fl");

    act(() => {
      fire("voice://convo/turn", { transcript: "fix the flaky test" });
    });
    // No LLM between speech and the agent: the transcript submits directly,
    // a canned ack speaks, and the utterance seals.
    expect(submitTranscript).toHaveBeenCalledWith("fix the flaky test");
    expect(mocks.sendVoiceBridgeMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_turn" }),
    );
    expect(mocks.speakConvoChunk).toHaveBeenCalledWith("On it.");
    expect(mocks.endConvoSpeech).toHaveBeenCalledTimes(1);
    expect(result.current.interimText).toBeNull();

    // The submitted tab is tracked: its turn completion announces via the
    // brain with a label derived from the transcript.
    mocks.sendVoiceBridgeMessage.mockClear();
    act(() => {
      emitAgentTurnComplete({ tabId: "t1", text: "Fixed. Tests green." });
    });
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voice_task_event",
        taskTabId: "t1",
        label: "fix the flaky test",
        status: "completed",
      }),
    );

    act(() => result.current.exit());
    expect(isConversationActive()).toBe(false);
    expect(mocks.stopVoiceConvo).toHaveBeenCalled();
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledWith({
      type: "voice_session_reset",
    });
  });

  it("streams brain deltas as clause chunks and seals on end", async () => {
    const { result } = makeController();
    act(() => result.current.enter());
    await flush();

    act(() => {
      emitVoiceBrainDelta({
        text: "Sure — I'll take care of that right away. Also",
      });
    });
    expect(mocks.speakConvoChunk).toHaveBeenCalledWith(
      "Sure — I'll take care of that right away.",
    );

    act(() => {
      emitVoiceBrainEnd({ text: "whole reply" });
    });
    // The buffered tail speaks, then the utterance seals.
    expect(mocks.speakConvoChunk).toHaveBeenLastCalledWith("Also");
    expect(mocks.endConvoSpeech).toHaveBeenCalledTimes(1);
  });

  it("announces a dispatched task's completion exactly once", async () => {
    const { result } = makeController();
    act(() => result.current.enter());
    await flush();

    act(() => {
      emitVoiceBrainEnd({
        text: "On it.",
        dispatched: { tabId: "task-tab", label: "fix tests" },
      });
    });
    mocks.sendVoiceBridgeMessage.mockClear();

    act(() => {
      emitAgentTurnComplete({
        tabId: "task-tab",
        text: "All 42 tests pass.\n```diff\n+fix\n```",
      });
    });
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledTimes(1);
    const message = mocks.sendVoiceBridgeMessage.mock.calls[0]?.[0] as {
      type: string;
      taskTabId: string;
      finalText: string;
    };
    expect(message.type).toBe("voice_task_event");
    expect(message.taskTabId).toBe("task-tab");
    expect(message.finalText).not.toContain("+fix");

    // A later turn on the same tab belongs to the user — no re-announcement.
    act(() => {
      emitAgentTurnComplete({ tabId: "task-tab", text: "later turn" });
    });
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledTimes(1);

    // Untracked tabs never announce.
    act(() => {
      emitAgentTurnComplete({ tabId: "other-tab", text: "irrelevant" });
    });
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledTimes(1);
  });

  it("barge-in aborts the brain; brain errors unwedge the engine", async () => {
    const { result } = makeController();
    act(() => result.current.enter());
    await flush();

    act(() => {
      fire("voice://convo/state", { state: "speaking" });
    });
    expect(result.current.phase).toBe("speaking");
    act(() => {
      fire("voice://convo/state", { state: "listening", reason: "barge-in" });
    });
    expect(mocks.sendVoiceBridgeMessage).toHaveBeenCalledWith({
      type: "voice_brain_abort",
    });
    expect(result.current.phase).toBe("listening");

    act(() => {
      emitVoiceBrainError({ message: "provider down" });
    });
    expect(result.current.error).toBe("provider down");
    expect(mocks.cancelConvoSpeech).toHaveBeenCalled();
  });

  it("surfaces a failed engine start and retries via primaryAction", async () => {
    mocks.startVoiceConvo.mockRejectedValueOnce(
      new Error("Deepgram API key missing"),
    );
    const { result } = makeController();
    act(() => result.current.enter());
    await flush();
    expect(result.current.error).toContain("Deepgram API key missing");
    expect(result.current.phase).toBe("idle");
    expect(result.current.active).toBe(true);

    act(() => result.current.primaryAction());
    await flush();
    expect(mocks.startVoiceConvo).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("listening");
    act(() => result.current.exit());
  });

  it("push-to-talk release forces the turn end while listening", async () => {
    const { result } = makeController();
    act(() => result.current.enter());
    await flush();
    act(() => result.current.endHold());
    expect(mocks.forceConvoEndTurn).toHaveBeenCalledTimes(1);
  });
});
