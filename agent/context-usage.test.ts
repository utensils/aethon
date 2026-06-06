import { describe, expect, it, vi } from "vitest";
import type { AethonAgentState, TabRecord } from "./state";
import {
  clearPendingContextUsageEmit,
  contextUsageSnapshot,
  emitContextUsage,
} from "./context-usage";
import { handleSessionEvent } from "./tab-lifecycle";

function stateWithCompaction(overrides: Record<string, unknown> = {}) {
  return {
    currentAgentTabId: undefined,
    turnStartTimes: new Map(),
    settingsManager: {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 200,
        keepRecentTokens: 100,
      }),
    },
    ...overrides,
  } as unknown as AethonAgentState;
}

function recWithUsage(
  usage: { tokens: number | null; contextWindow: number; percent: number | null },
): TabRecord {
  return {
    id: "tab-1",
    session: {
      model: {
        id: "claude",
        provider: "anthropic",
        name: "Claude",
        contextWindow: usage.contextWindow,
      },
      getContextUsage: () => usage,
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
  };
}

describe("contextUsageSnapshot", () => {
  it("reports compaction threshold and remaining tokens from pi settings", () => {
    const snapshot = contextUsageSnapshot(
      stateWithCompaction(),
      "tab-1",
      recWithUsage({ tokens: 1_000, contextWindow: 2_000, percent: 50 }),
    );

    expect(snapshot).toMatchObject({
      tabId: "tab-1",
      model: "anthropic/claude",
      status: "known",
      tokens: 1_000,
      contextWindow: 2_000,
      autoCompactEnabled: true,
      reserveTokens: 200,
      compactAtTokens: 1_800,
      tokensUntilCompact: 800,
    });
  });

  it("flags saturated when authoritative tokens reach the window", () => {
    const snapshot = contextUsageSnapshot(
      stateWithCompaction(),
      "tab-1",
      recWithUsage({ tokens: 2_000, contextWindow: 2_000, percent: 100 }),
    );

    expect(snapshot?.saturated).toBe(true);
    expect(snapshot?.tokensUntilCompact).toBe(0);
  });

  it("does not flag saturated below the window", () => {
    const snapshot = contextUsageSnapshot(
      stateWithCompaction(),
      "tab-1",
      recWithUsage({ tokens: 1_799, contextWindow: 2_000, percent: 89.95 }),
    );

    expect(snapshot?.saturated).toBeUndefined();
  });

  it("keeps post-compaction usage unknown until pi reports fresh tokens", () => {
    const snapshot = contextUsageSnapshot(
      stateWithCompaction(),
      "tab-1",
      recWithUsage({ tokens: null, contextWindow: 2_000, percent: null }),
    );

    expect(snapshot).toMatchObject({
      status: "unknown",
      tokens: null,
      percent: null,
      compactAtTokens: 1_800,
      tokensUntilCompact: null,
    });
  });
});

describe("live context updates", () => {
  it("cancels pending throttled context emits when a tab record is discarded", () => {
    vi.useFakeTimers();
    try {
      const rec = recWithUsage({
        tokens: 1_000,
        contextWindow: 2_000,
        percent: 50,
      });
      const fired = vi.fn();
      rec.contextUsageEmitTimer = setTimeout(fired, 100);

      clearPendingContextUsageEmit(rec);
      vi.advanceTimersByTime(100);

      expect(fired).not.toHaveBeenCalled();
      expect(rec.contextUsageEmitTimer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a realtime estimated context snapshot while text is streaming", () => {
    const state = stateWithCompaction();
    const rec = recWithUsage({
      tokens: 1_000,
      contextWindow: 2_000,
      percent: 50,
    });
    const sent: Record<string, unknown>[] = [];

    handleSessionEvent(
      state,
      { send: (msg) => sent.push(msg) },
      rec,
      "tab-1",
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "streaming response grows the visible context meter",
        },
      },
    );

    const context = sent.find((msg) => msg.type === "context_usage");
    expect(context).toMatchObject({
      type: "context_usage",
      tabId: "tab-1",
      tokens: 1_000,
      estimatedTokens: expect.any(Number),
      transientTokens: expect.any(Number),
      tokensUntilCompact: 800,
    });
    expect(context?.estimatedTokens).toBeGreaterThan(1_000);
    expect(context?.estimatedTokensUntilCompact).toBeLessThan(800);
  });

  it("marks live bash-output saturation without changing provider usage", () => {
    const state = stateWithCompaction({
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 100,
        }),
      },
    });
    const rec = recWithUsage({
      tokens: 199_999,
      contextWindow: 272_000,
      percent: 73.5,
    });
    const sent: Record<string, unknown>[] = [];

    handleSessionEvent(
      state,
      { send: (msg) => sent.push(msg) },
      rec,
      "tab-1",
      {
        type: "tool_execution_update",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "yes" },
        partialResult: {
          content: [{ type: "text", text: "x".repeat(320_000) }],
        },
      },
    );

    const context = sent.find((msg) => msg.type === "context_usage");
    expect(context).toMatchObject({
      tokens: 199_999,
      percent: 73.5,
      compactAtTokens: 255_616,
      tokensUntilCompact: 55_617,
      saturatedByEstimate: true,
    });
    expect(context?.estimatedTokens).toBeGreaterThan(272_000);
    expect(context?.estimatedTokensUntilCompact).toBe(0);
    expect(context?.saturatedByProvider).toBeUndefined();
    expect(context?.saturated).toBeUndefined();
  });

  it("counts only task partial deltas in live context estimates", () => {
    const state = stateWithCompaction();
    const rec = recWithUsage({
      tokens: 1_000,
      contextWindow: 2_000,
      percent: 50,
    });
    const sent: Record<string, unknown>[] = [];
    const deps = { send: (msg: Record<string, unknown>) => sent.push(msg) };

    handleSessionEvent(state, deps, rec, "tab-1", {
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { subagent_type: "coder", prompt: "fix it" },
    });
    const beforePartials = rec.contextUsageTransientTokens ?? 0;
    handleSessionEvent(state, deps, rec, "tab-1", {
      type: "tool_execution_update",
      toolCallId: "task-1",
      toolName: "task",
      args: { subagent_type: "coder", prompt: "fix it" },
      partialResult: { content: [{ type: "text", text: "abcd" }] },
    });
    handleSessionEvent(state, deps, rec, "tab-1", {
      type: "tool_execution_update",
      toolCallId: "task-1",
      toolName: "task",
      args: { subagent_type: "coder", prompt: "fix it" },
      partialResult: { content: [{ type: "text", text: "abcdef" }] },
    });

    // estimateTokens is ceil(chars / 4), so "abcd" contributes 1 and the
    // cumulative update's delta "ef" contributes 1. Counting full snapshots
    // would yield 3 instead.
    expect((rec.contextUsageTransientTokens ?? 0) - beforePartials).toBe(2);
  });

  it("clears transient estimates for authoritative turn-end usage", () => {
    const state = stateWithCompaction({ currentAgentTabId: "tab-1" });
    const rec = recWithUsage({
      tokens: 1_000,
      contextWindow: 2_000,
      percent: 50,
    });
    rec.contextUsageTransientTokens = 50;
    const sent: Record<string, unknown>[] = [];

    emitContextUsage(state, { send: (msg) => sent.push(msg) }, "tab-1", rec);
    handleSessionEvent(
      state,
      { send: (msg) => sent.push(msg) },
      rec,
      "tab-1",
      { type: "agent_end", messages: [{ role: "assistant" }] },
    );

    const contexts = sent.filter((msg) => msg.type === "context_usage");
    expect(contexts.at(-1)).toMatchObject({ tokens: 1_000 });
    expect(rec.contextUsageTransientTokens).toBe(0);
  });
});
