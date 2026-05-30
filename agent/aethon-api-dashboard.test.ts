import { describe, expect, it, vi } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";
import { buildDashboardApi, buildTasksApi } from "./aethon-api-dashboard";
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
  const send = (m: Record<string, unknown>) => sent.push(m);
  return {
    state,
    sent,
    tasks: buildTasksApi(state, { send }),
    dashboard: buildDashboardApi(state, { send }),
  };
}

describe("buildTasksApi", () => {
  it("rejects missing projectPath / prompt without sending", async () => {
    const { tasks, sent } = makeFixture();
    await expect(tasks.start({ projectPath: "", prompt: "go" })).resolves.toEqual(
      { ok: false, error: "projectPath required" },
    );
    await expect(
      tasks.start({ projectPath: "/repo", prompt: "   " }),
    ).resolves.toEqual({ ok: false, error: "prompt required" });
    expect(sent).toHaveLength(0);
  });

  it("forwards a start_task with only the provided optional fields", async () => {
    const { state, sent, tasks } = makeFixture();
    markFrontendReady(state);
    const p = tasks.start({
      projectPath: "/repo",
      prompt: "build it",
      newWorktree: true,
    });
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "dashboard_query",
      op: "start_task",
      args: { projectPath: "/repo", prompt: "build it", newWorktree: true },
    });
    // branch/baseBranch were omitted, so they must not appear in args.
    expect(msg.args).not.toHaveProperty("branch");
    expect(msg.args).not.toHaveProperty("baseBranch");
    ackMutation(state, msg.mutationId as string, true);
    await expect(p).resolves.toEqual({ ok: true });
  });
});

describe("buildDashboardApi", () => {
  it("getRepoOverview / listIssues require a projectPath", async () => {
    const { dashboard, sent } = makeFixture();
    await expect(
      dashboard.getRepoOverview({ projectPath: "" }),
    ).resolves.toEqual({ ok: false, error: "projectPath required" });
    await expect(dashboard.listIssues({ projectPath: "" })).resolves.toEqual({
      ok: false,
      error: "projectPath required",
    });
    expect(sent).toHaveLength(0);
  });

  it("getIssue requires a positive integer issue number", async () => {
    const { dashboard } = makeFixture();
    await expect(
      dashboard.getIssue({ projectPath: "/repo", number: 0 }),
    ).resolves.toEqual({
      ok: false,
      error: "projectPath + positive integer number required",
    });
  });

  it("returns frontend_not_ready when the handshake never completes", async () => {
    vi.useFakeTimers();
    try {
      const { dashboard } = makeFixture();
      const p = dashboard.getRepoOverview({ projectPath: "/repo" });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({
        ok: false,
        error: "frontend_not_ready",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refresh forwards an empty-arg query and resolves on ack", async () => {
    const { state, sent, dashboard } = makeFixture();
    markFrontendReady(state);
    const p = dashboard.refresh();
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "dashboard_query",
      op: "refresh",
      args: {},
    });
    ackMutation(state, msg.mutationId as string, true, undefined, { ok: 1 });
    await expect(p).resolves.toEqual({ ok: true, data: { ok: 1 } });
  });
});
