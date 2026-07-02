import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleShellQuery } from "./shellQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleShellQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("routes list to shell_list_shareable and acks with data", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(["tab-1", "tab-2"]);
    handleShellQuery(
      { type: "shell_query", op: "list", mutationId: "m1" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("shell_list_shareable");
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true, undefined, [
      "tab-1",
      "tab-2",
    ]);
  });

  it("creates shell tabs without opening the terminal panel by default", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { tabs: [], terminal: { open: false }, terminalPanel: {} },
    });
    harness.invoke.mockResolvedValueOnce(undefined);

    handleShellQuery(
      {
        type: "shell_query",
        op: "create",
        mutationId: "m-create",
        args: {
          tabId: "shell-test",
          cwd: "/repo",
          command: "zsh",
          args: ["-l"],
          shareMode: "read-write-trusted",
          activate: false,
        },
      },
      ctx,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("shell_open", {
      args: {
        tabId: "shell-test",
        command: "zsh",
        args: ["-l"],
        cwd: "/repo",
      },
    });
    expect(ctx.stateRef.current).toMatchObject({
      terminal: { open: false },
      terminalPanel: {},
      tabs: [
        expect.objectContaining({
          id: "shell-test",
          kind: "shell",
          terminalBuffer: "",
          shell: expect.objectContaining({
            cwd: "/repo",
            command: "zsh",
            args: ["-l"],
            shareMode: "private",
            shellState: "running",
          }),
        }),
      ],
    });
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-create",
        true,
        undefined,
        expect.objectContaining({ tabId: "shell-test" }),
      ),
    );
  });

  it("does not send local fallback cwd or devshell seed for remote overview shells", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        tabs: [],
        terminal: { open: false },
        terminalPanel: {},
        aethonRoot: "/Users/example/.aethon",
        projectRoot: "/Users/example/Projects/aethon",
      },
    });
    ctx.sourceHostId = "remote:abc";
    harness.invoke.mockResolvedValueOnce(undefined);

    handleShellQuery(
      {
        type: "shell_query",
        op: "create",
        mutationId: "m-remote-create",
        args: {
          tabId: "remote-shell",
          activate: false,
        },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-remote-create",
        true,
        undefined,
        expect.objectContaining({
          tabId: "remote-shell",
          cwd: "",
          hostId: "remote:abc",
        }),
      ),
    );
    expect(harness.invoke).toHaveBeenCalledWith("remote_host_invoke", {
      id: "remote:abc",
      cmd: "shell_open",
      args: { args: { tabId: "remote-shell" } },
    });
    expect(ctx.stateRef.current).toMatchObject({
      tabs: [
        expect.objectContaining({
          id: "remote-shell",
          hostId: "remote:abc",
          terminalBuffer: "",
          shell: expect.objectContaining({
            cwd: "",
            shellState: "running",
          }),
        }),
      ],
    });
  });

  it("resets active sub-tab when activated shell creation fails", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { tabs: [], terminalPanel: {}, terminal: { open: false } },
    });
    harness.invoke.mockRejectedValueOnce(new Error("spawn failed"));

    handleShellQuery(
      {
        type: "shell_query",
        op: "create",
        mutationId: "m-fail",
        args: { tabId: "shell-fail", activate: true },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-fail",
        false,
        "spawn failed",
      ),
    );
    expect(ctx.stateRef.current).toMatchObject({
      tabs: [],
      terminalPanel: { activeSubId: "agent-bash" },
      terminal: { open: true },
    });
  });

  it("rejects duplicate shell ids without mutating existing tabs", async () => {
    const existing = {
      id: "shell-test",
      label: "Existing",
      kind: "shell",
      terminalBuffer: "keep",
      shell: {
        cwd: "/old",
        command: "zsh",
        args: [],
        shareMode: "read",
        shellState: "running",
      },
    };
    const { ctx, mocks } = buildHandlerFixture({ state: { tabs: [existing] } });

    handleShellQuery(
      {
        type: "shell_query",
        op: "create",
        mutationId: "m-dup",
        args: { tabId: "shell-test", cwd: "/repo" },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-dup",
        false,
        "shell tab already exists: shell-test",
      ),
    );
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "shell_open",
      expect.anything(),
    );
    expect(ctx.stateRef.current.tabs).toEqual([existing]);
  });

  it("acks failure for unknown ops", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleShellQuery(
      { type: "shell_query", op: "explode", mutationId: "m2" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m2",
      false,
      "unknown shell_query op: explode",
    );
  });
});
