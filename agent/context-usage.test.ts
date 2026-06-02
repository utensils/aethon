import { describe, expect, it } from "vitest";
import type { AethonAgentState, TabRecord } from "./state";
import {
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
      tokens: expect.any(Number),
    });
    expect(context?.tokens).toBeGreaterThan(1_000);
    expect(context?.tokensUntilCompact).toBeLessThan(800);
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
