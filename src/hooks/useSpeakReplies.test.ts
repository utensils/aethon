// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { useSpeakReplies } from "./useSpeakReplies";
import { emitAgentTurnComplete } from "../utils/agentTurnEvents";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function stateRef(
  value: Record<string, unknown>,
): MutableRefObject<Record<string, unknown>> {
  return { current: value };
}

describe("useSpeakReplies", () => {
  beforeEach(() => invokeMock.mockClear());
  // Unmount the hook between tests so its window listener doesn't leak and fire
  // on a later test's emit.
  afterEach(() => cleanup());

  it("speaks the reply on the active tab when enabled", () => {
    const ref = stateRef({
      activeTabId: "t1",
      voice: { speakAgentReplies: true, speakMaxChars: 600 },
    });
    renderHook(() => useSpeakReplies(ref));

    emitAgentTurnComplete({ tabId: "t1", text: "All done." });

    expect(invokeMock).toHaveBeenCalledWith("voice_speak", { text: "All done." });
  });

  it("does nothing when speak-agent-replies is off", () => {
    const ref = stateRef({
      activeTabId: "t1",
      voice: { speakAgentReplies: false, speakMaxChars: 600 },
    });
    renderHook(() => useSpeakReplies(ref));

    emitAgentTurnComplete({ tabId: "t1", text: "All done." });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("ignores turns finishing on a background tab", () => {
    const ref = stateRef({
      activeTabId: "t1",
      voice: { speakAgentReplies: true, speakMaxChars: 600 },
    });
    renderHook(() => useSpeakReplies(ref));

    emitAgentTurnComplete({ tabId: "t2", text: "Background reply." });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("skips empty / tool-only turns", () => {
    const ref = stateRef({
      activeTabId: "t1",
      voice: { speakAgentReplies: true, speakMaxChars: 600 },
    });
    renderHook(() => useSpeakReplies(ref));

    emitAgentTurnComplete({ tabId: "t1", text: "   " });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("caps long replies to speakMaxChars", () => {
    const ref = stateRef({
      activeTabId: "t1",
      voice: { speakAgentReplies: true, speakMaxChars: 12 },
    });
    renderHook(() => useSpeakReplies(ref));

    emitAgentTurnComplete({
      tabId: "t1",
      text: "one two three four five six seven",
    });

    const spoken = invokeMock.mock.calls[0]?.[1] as { text: string };
    expect(spoken.text.length).toBeLessThanOrEqual(12);
  });
});
