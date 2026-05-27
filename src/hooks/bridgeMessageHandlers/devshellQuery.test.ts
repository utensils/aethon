import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleDevshellQuery } from "./devshellQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleDevshellQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("routes status op to devshell_status with args", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    const fakeStatus = { enabled: "auto", mode: "auto", snapshot: { state: "none" } };
    harness.invoke.mockResolvedValueOnce(fakeStatus);
    handleDevshellQuery(
      {
        type: "devshell_query",
        op: "status",
        mutationId: "m1",
        args: { root: "/proj" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("devshell_status", {
      args: { root: "/proj" },
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true, undefined, fakeStatus);
  });

  it("routes env_for_path op and acks with env map", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    const fakeResp = {
      enabled: "auto",
      kind: "flake",
      stale: false,
      env: { PATH: "/nix/store/abc/bin", RUSTC: "/nix/store/xyz/bin/rustc" },
    };
    harness.invoke.mockResolvedValueOnce(fakeResp);
    handleDevshellQuery(
      {
        type: "devshell_query",
        op: "env_for_path",
        mutationId: "m2",
        args: { cwd: "/proj" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("devshell_env_for_path", {
      args: { cwd: "/proj" },
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m2", true, undefined, fakeResp);
  });

  it("routes refresh op", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(undefined);
    handleDevshellQuery(
      {
        type: "devshell_query",
        op: "refresh",
        mutationId: "m3",
        args: { root: "/proj" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("devshell_refresh", {
      args: { root: "/proj" },
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m3", true, undefined, undefined);
  });

  it("acks failure when status op missing root", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleDevshellQuery(
      { type: "devshell_query", op: "status", mutationId: "m4", args: {} },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m4",
      false,
      "devshell_query.status requires root",
    );
  });

  it("acks failure for unknown ops", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleDevshellQuery(
      { type: "devshell_query", op: "explode", mutationId: "m5" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m5",
      false,
      "unknown devshell_query op: explode",
    );
  });

  it("propagates IPC errors as ack failures", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockRejectedValueOnce(new Error("rust said no"));
    handleDevshellQuery(
      {
        type: "devshell_query",
        op: "env_for_path",
        mutationId: "m6",
        args: { cwd: "/proj" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith("m6", false, "rust said no");
  });
});
