import { describe, expect, it, vi } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";
import { buildShellsApi } from "./aethon-api-shells";
import { ackMutation, markFrontendReady } from "./mutation-ack";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  const api = buildShellsApi(state, { send: (m) => sent.push(m) });
  return { state, sent, api };
}

describe("buildShellsApi", () => {
  // Validation happens before the frontend-ready gate, so these resolve
  // synchronously regardless of handshake state.
  it("read rejects a missing/blank tabId without sending", async () => {
    const { api, sent } = makeFixture();
    await expect(api.read({ tabId: "" })).resolves.toEqual({
      ok: false,
      error: "tabId required",
    });
    expect(sent).toHaveLength(0);
  });

  it("write rejects a missing tabId and a non-string text", async () => {
    const { api } = makeFixture();
    await expect(api.write({ tabId: "", text: "hi" })).resolves.toEqual({
      ok: false,
      error: "tabId required",
    });
    await expect(
      api.write({ tabId: "tab-1", text: 7 as unknown as string }),
    ).resolves.toEqual({ ok: false, error: "text must be a string" });
  });

  it("list returns frontend_not_ready when the handshake never completes", async () => {
    vi.useFakeTimers();
    try {
      const { api, sent } = makeFixture();
      // Bounded wait elapses with no readiness flip → clean failure, no hang.
      const p = api.list();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({
        ok: false,
        error: "frontend_not_ready",
      });
      expect(sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("read forwards a shell_query with optional bounds once ready", async () => {
    const { state, sent, api } = makeFixture();
    markFrontendReady(state);
    const p = api.read({ tabId: "tab-1", sinceTotal: 10, maxBytes: 256 });
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "shell_query",
      op: "read",
      args: { tabId: "tab-1", sinceTotal: 10, maxBytes: 256 },
    });
    ackMutation(state, msg.mutationId as string, true, undefined, { lines: [] });
    await expect(p).resolves.toEqual({ ok: true, data: { lines: [] } });
  });

  it("write forwards the tabId+text payload once ready", async () => {
    const { state, sent, api } = makeFixture();
    markFrontendReady(state);
    const p = api.write({ tabId: "tab-2", text: "echo hi\n" });
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "shell_query",
      op: "write",
      args: { tabId: "tab-2", text: "echo hi\n" },
    });
    ackMutation(state, msg.mutationId as string, true);
    await expect(p).resolves.toEqual({ ok: true });
  });
});
