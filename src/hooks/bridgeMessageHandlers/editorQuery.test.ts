import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleEditorQuery } from "./editorQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleEditorQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("opens relative paths against the supplied cwd", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(true);

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m1",
        args: { path: "src/App.tsx", cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    expect(harness.invoke).toHaveBeenCalledWith("fs_exists", {
      root: "/repo",
      path: "/repo/src/App.tsx",
    });
    expect(mocks.newEditorTab).toHaveBeenCalledWith("/repo/src/App.tsx", {
      rootPath: "/repo",
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true, undefined, {
      filePath: "/repo/src/App.tsx",
      rootPath: "/repo",
    });
  });

  it("validates absolute paths against the supplied cwd", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(true);

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m2",
        args: { path: "/repo/docs/api.md", cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    expect(harness.invoke).toHaveBeenCalledWith("fs_exists", {
      root: "/repo",
      path: "/repo/docs/api.md",
    });
    expect(mocks.newEditorTab).toHaveBeenCalledWith("/repo/docs/api.md", {
      rootPath: "/repo",
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m2", true, undefined, {
      filePath: "/repo/docs/api.md",
      rootPath: "/repo",
    });
  });

  it("uses explicit rootPath when provided", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(true);

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m3",
        args: {
          path: "config.toml",
          cwd: "/repo",
          rootPath: "/Users/test/.aethon",
        },
      },
      ctx,
    );

    await flush();
    expect(harness.invoke).toHaveBeenCalledWith("fs_exists", {
      root: "/Users/test/.aethon",
      path: "/Users/test/.aethon/config.toml",
    });
    expect(mocks.newEditorTab).toHaveBeenCalledWith(
      "/Users/test/.aethon/config.toml",
      { rootPath: "/Users/test/.aethon" },
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith("m3", true, undefined, {
      filePath: "/Users/test/.aethon/config.toml",
      rootPath: "/Users/test/.aethon",
    });
  });

  it("reports the existing editor tab id in the success data", async () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        tabs: [
          {
            id: "ed-1",
            kind: "editor",
            editor: { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
          },
        ],
      },
    });
    harness.invoke.mockResolvedValueOnce(true);

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m4",
        args: { path: "src/App.tsx", cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    expect(mocks.newEditorTab).toHaveBeenCalledWith("/repo/src/App.tsx", {
      rootPath: "/repo",
    });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m4", true, undefined, {
      filePath: "/repo/src/App.tsx",
      rootPath: "/repo",
      tabId: "ed-1",
    });
  });

  it("acks failure when path is missing", async () => {
    const { ctx, mocks } = buildHandlerFixture();

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m5",
        args: { cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    expect(mocks.newEditorTab).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m5",
      false,
      "editor_query.open_file requires path",
    );
  });

  it("acks failure when cwd and rootPath are missing", async () => {
    const { ctx, mocks } = buildHandlerFixture();

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m6",
        args: { path: "README.md" },
      },
      ctx,
    );

    await flush();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m6",
      false,
      "editor_query.open_file requires cwd or rootPath",
    );
  });

  it("acks failure when the file is outside the root or absent", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(false);

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m7",
        args: { path: "../secret.txt", cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    expect(mocks.newEditorTab).not.toHaveBeenCalled();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m7",
      false,
      "file not found or outside root: ../secret.txt",
    );
  });

  it("acks failure for unknown ops", async () => {
    const { ctx, mocks } = buildHandlerFixture();

    handleEditorQuery(
      { type: "editor_query", op: "explode", mutationId: "m8" },
      ctx,
    );

    await flush();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m8",
      false,
      "unknown editor_query op: explode",
    );
  });

  it("propagates IPC errors as ack failures", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockRejectedValueOnce(new Error("rust said no"));

    handleEditorQuery(
      {
        type: "editor_query",
        op: "open_file",
        mutationId: "m9",
        args: { path: "README.md", cwd: "/repo" },
      },
      ctx,
    );

    await flush();
    await flush();
    expect(mocks.ackMutation).toHaveBeenCalledWith("m9", false, "rust said no");
  });
});
