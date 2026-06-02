import { beforeEach, describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  getWorkingContext,
  _resetGitContextCacheForTests,
  type GitContextDeps,
} from "./git-context";

function makeState(): AethonAgentState {
  const userDir = "/tmp/aethon-gc";
  const opts: AethonAgentStateOptions = {
    userDir,
    stateFile: `${userDir}/state.json`,
    sessionsDir: `${userDir}/sessions`,
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
  const state = new AethonAgentState(opts);
  state.frontendReady = true;
  return state;
}

/** Build a deps.send that synchronously resolves the matching pending
 *  mutation with `reply` — modelling the frontend's `git_query` ack. */
function replyWith(
  state: AethonAgentState,
  sent: Record<string, unknown>[],
  reply: { ok: boolean; error?: string; data?: unknown },
): GitContextDeps {
  return {
    send: (msg) => {
      sent.push(msg);
      const id = msg.mutationId as string;
      const pending = state.pendingMutations.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        state.pendingMutations.delete(id);
        pending.resolve(reply);
      }
    },
  };
}

describe("getWorkingContext", () => {
  beforeEach(() => _resetGitContextCacheForTests());

  it("queries the bridge and normalizes the git working context", async () => {
    const state = makeState();
    const sent: Record<string, unknown>[] = [];
    const deps = replyWith(state, sent, {
      ok: true,
      data: {
        repoRoot: "/r",
        branch: "main",
        isWorktree: false,
        changedFiles: 2,
        ahead: 1,
        behind: 0,
      },
    });
    const ctx = await getWorkingContext(state, deps, "/r", 1000);
    expect(sent[0]).toMatchObject({
      type: "git_query",
      op: "working_context",
      args: { cwd: "/r" },
    });
    expect(ctx).toEqual({
      repoRoot: "/r",
      branch: "main",
      isWorktree: false,
      changedFiles: 2,
      ahead: 1,
      behind: 0,
    });
  });

  it("serves a cached result within the TTL without re-querying", async () => {
    const state = makeState();
    const sent: Record<string, unknown>[] = [];
    const deps = replyWith(state, sent, {
      ok: true,
      data: { repoRoot: "/r", branch: "main", isWorktree: false, changedFiles: 0, ahead: 0, behind: 0 },
    });
    await getWorkingContext(state, deps, "/r", 1000);
    await getWorkingContext(state, deps, "/r", 2000); // within 2.5s TTL
    expect(sent).toHaveLength(1);
    // Past the TTL → a fresh query.
    await getWorkingContext(state, deps, "/r", 9000);
    expect(sent).toHaveLength(2);
  });

  it("returns null when the cwd is not a git repository", async () => {
    const state = makeState();
    const sent: Record<string, unknown>[] = [];
    const deps = replyWith(state, sent, { ok: true, data: null });
    const ctx = await getWorkingContext(state, deps, "/tmp/plain", 1000);
    expect(ctx).toBeNull();
  });

  it("degrades to null on a failed query without throwing", async () => {
    const state = makeState();
    const sent: Record<string, unknown>[] = [];
    const deps = replyWith(state, sent, { ok: false, error: "timeout" });
    const ctx = await getWorkingContext(state, deps, "/r", 1000);
    expect(ctx).toBeNull();
  });

  it("normalizes partial/garbage payloads to safe defaults", async () => {
    const state = makeState();
    const sent: Record<string, unknown>[] = [];
    const deps = replyWith(state, sent, {
      ok: true,
      data: { branch: 42, changedFiles: "lots" },
    });
    const ctx = await getWorkingContext(state, deps, "/r", 1000);
    expect(ctx).toEqual({
      repoRoot: null,
      branch: null,
      isWorktree: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    });
  });
});
