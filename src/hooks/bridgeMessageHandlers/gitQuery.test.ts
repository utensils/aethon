import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleGitQuery } from "./gitQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleGitQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("routes working_context op to git_working_context and acks the result", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    const fakeCtx = {
      repoRoot: "/proj",
      branch: "main",
      isWorktree: false,
      changedFiles: 3,
      ahead: 2,
      behind: 0,
    };
    harness.invoke.mockResolvedValueOnce(fakeCtx);
    handleGitQuery(
      {
        type: "git_query",
        op: "working_context",
        mutationId: "g1",
        args: { cwd: "/proj" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("git_working_context", {
      cwd: "/proj",
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("g1", true, undefined, fakeCtx);
  });

  it("acks null through unchanged when the cwd is not a git repo", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(null);
    handleGitQuery(
      { type: "git_query", op: "working_context", mutationId: "g2", args: { cwd: "/tmp" } },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith("g2", true, undefined, null);
  });

  it("rejects a missing cwd", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleGitQuery(
      { type: "git_query", op: "working_context", mutationId: "g3", args: {} },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "g3",
      false,
      "git_query.working_context requires cwd",
    );
  });

  it("rejects an unknown op", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleGitQuery({ type: "git_query", op: "explode", mutationId: "g4" }, ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "g4",
      false,
      "unknown git_query op: explode",
    );
  });
});
