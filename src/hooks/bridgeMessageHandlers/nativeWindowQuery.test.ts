import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNativeWindowQuery } from "./nativeWindowQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";
import type { NativeCanvasWindowRecord } from "../../nativeWindows";

const record: NativeCanvasWindowRecord = {
  id: "Workpad",
  label: "aethon-canvas-Workpad",
  kind: "canvas",
  title: "Workpad",
  tabId: "default",
  restoreOnLaunch: true,
  components: [{ id: "root", type: "card", props: { title: "One" } }],
  state: { count: 1 },
};

describe("handleNativeWindowQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("opens a canvas window through Rust and mirrors summaries to state", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(record);
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "open_canvas",
        mutationId: "m1",
        args: {
          id: "Workpad",
          title: "Workpad",
          components: { components: record.components },
          state: record.state,
        },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("native_window_open_canvas", {
      input: {
        id: "Workpad",
        title: "Workpad",
        components: record.components,
        state: record.state,
      },
    });
    expect(ctx.nativeWindowsRef.current.get("Workpad")).toEqual(record);
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      true,
      undefined,
      record,
    );
  });

  it("patches canvas content and persists the full record", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.nativeWindowsRef.current.set("Workpad", record);
    harness.invoke.mockImplementation((_cmd, args) =>
      Promise.resolve(args.record),
    );
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "patch_canvas",
        mutationId: "m2",
        args: {
          id: "Workpad",
          path: "/components/0/props/title",
          value: "Two",
        },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("native_window_save_canvas", {
      record: {
        ...record,
        components: [{ id: "root", type: "card", props: { title: "Two" } }],
      },
    });
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m2",
        true,
        undefined,
        expect.objectContaining({
          id: "Workpad",
          components: [{ id: "root", type: "card", props: { title: "Two" } }],
        }),
      ),
    );
  });

  it("falls back to Rust-owned records for read queries", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(record);

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "get",
        mutationId: "m-get-rust",
        args: { id: "Workpad" },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith("native_window_get_canvas", {
        id: "Workpad",
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-get-rust",
        true,
        undefined,
        record,
      ),
    );
    expect(ctx.nativeWindowsRef.current.get("Workpad")).toEqual(record);
  });

  it("opens a terminal window by creating a shell and binding shell-canvas", async () => {
    const { ctx, mocks } = buildHandlerFixture({ state: { tabs: [] } });
    const opened: NativeCanvasWindowRecord = {
      ...record,
      id: "Term",
      label: "aethon-canvas-Term",
      title: "Terminal",
    };
    harness.invoke.mockImplementation((command, args) => {
      if (command === "shell_open") return Promise.resolve(undefined);
      if (command === "native_window_open_canvas") {
        return Promise.resolve({ ...opened, ...args.input });
      }
      if (command === "native_window_save_canvas") {
        return Promise.resolve(args.record);
      }
      return Promise.resolve(undefined);
    });

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "open_terminal",
        mutationId: "m-terminal",
        args: {
          id: "Term",
          title: "Terminal",
          shellTabId: "shell-term",
          cwd: "/repo",
          command: "zsh",
        },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith("native_window_open_canvas", {
        input: expect.objectContaining({
          id: "Term",
          title: "Terminal",
          components: [
            expect.objectContaining({
              type: "shell-canvas",
              props: expect.objectContaining({ tabId: "shell-term" }),
            }),
          ],
          restoreOnLaunch: false,
          state: expect.objectContaining({
            tabs: [
              expect.objectContaining({ id: "shell-term", kind: "shell" }),
            ],
          }),
        }),
      }),
    );
    harness.fireEvent("native-canvas-window-ready", { id: "Term" });
    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith("shell_open", {
        args: expect.objectContaining({ tabId: "shell-term" }),
      }),
    );
    const openWindowOrder =
      harness.invoke.mock.invocationCallOrder[
        harness.invoke.mock.calls.findIndex(
          ([command]) => command === "native_window_open_canvas",
        )
      ];
    const shellOpenOrder =
      harness.invoke.mock.invocationCallOrder[
        harness.invoke.mock.calls.findIndex(
          ([command]) => command === "shell_open",
        )
      ];
    expect(openWindowOrder).toBeLessThan(shellOpenOrder);
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m-terminal",
      true,
      undefined,
      expect.objectContaining({ id: "Term" }),
    );
  });

  it("cleans up shells and native windows when terminal open partially fails", async () => {
    const { ctx, mocks } = buildHandlerFixture({ state: { tabs: [] } });
    harness.invoke.mockImplementation((command, args) => {
      if (command === "native_window_open_canvas") {
        return Promise.resolve({ ...record, id: "Term", ...args.input });
      }
      if (command === "shell_open") return Promise.resolve(undefined);
      if (command === "native_window_save_canvas") {
        return Promise.reject(new Error("save failed"));
      }
      return Promise.resolve(undefined);
    });

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "open_terminal",
        mutationId: "m-terminal-fail",
        args: {
          id: "Term",
          shellTabId: "shell-term",
          cwd: "/repo",
        },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "native_window_open_canvas",
        expect.anything(),
      ),
    );
    harness.fireEvent("native-canvas-window-ready", { id: "Term" });
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-terminal-fail",
        false,
        "save failed",
      ),
    );
    expect(harness.invoke).toHaveBeenCalledWith("shell_close", {
      tabId: "shell-term",
    });
    expect(harness.invoke).toHaveBeenCalledWith("native_window_close", {
      id: "Term",
    });
    expect(ctx.stateRef.current.tabs).toEqual([]);
    expect(ctx.nativeWindowsRef.current.has("Term")).toBe(false);
  });

  it("restores existing windows instead of closing them when terminal reuse fails", async () => {
    const previous: NativeCanvasWindowRecord = {
      ...record,
      id: "Term",
      title: "Existing",
      components: [{ id: "existing", type: "text", props: { content: "old" } }],
      state: { old: true },
    };
    const { ctx, mocks } = buildHandlerFixture({ state: { tabs: [] } });
    ctx.nativeWindowsRef.current.set("Term", previous);
    harness.invoke.mockImplementation((command, args) => {
      if (command === "native_window_open_canvas") {
        return Promise.resolve({
          ...previous,
          ...args.input,
          title: "Terminal",
        });
      }
      if (command === "shell_open") return Promise.resolve(undefined);
      if (command === "native_window_save_canvas") {
        return Promise.reject(new Error("save failed"));
      }
      return Promise.resolve(undefined);
    });

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "open_terminal",
        mutationId: "m-reuse-fail",
        args: { id: "Term", shellTabId: "shell-term" },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "native_window_open_canvas",
        expect.anything(),
      ),
    );
    harness.fireEvent("native-canvas-window-ready", { id: "Term" });
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-reuse-fail",
        false,
        "save failed",
      ),
    );
    expect(harness.invoke).not.toHaveBeenCalledWith("native_window_close", {
      id: "Term",
    });
    expect(harness.invoke).toHaveBeenCalledWith("native_window_set_title", {
      id: "Term",
      title: "Existing",
    });
    expect(ctx.nativeWindowsRef.current.get("Term")).toEqual(previous);
  });

  it("closes owned terminal shells when a terminal window is closed programmatically", async () => {
    const terminalRecord: NativeCanvasWindowRecord = {
      ...record,
      id: "Term",
      label: "aethon-canvas-Term",
      components: [
        {
          id: "terminal",
          type: "shell-canvas",
          props: { tabId: "shell-term" },
        },
      ],
      state: {
        tabs: [{ id: "shell-term", kind: "shell" }],
      },
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        tabs: [{ id: "shell-term", kind: "shell" }],
        terminalPanel: { activeSubId: "shell-term" },
      },
    });
    ctx.nativeWindowsRef.current.set("Term", terminalRecord);

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "close",
        mutationId: "m-close-terminal",
        args: { id: "Term" },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-close-terminal",
        true,
        undefined,
        { ok: true },
      ),
    );
    expect(harness.invoke).toHaveBeenCalledWith("native_window_close", {
      id: "Term",
    });
    expect(harness.invoke).toHaveBeenCalledWith("shell_close", {
      tabId: "shell-term",
    });
    expect(ctx.nativeWindowsRef.current.has("Term")).toBe(false);
    expect(ctx.stateRef.current.tabs).toEqual([]);
    expect(ctx.stateRef.current.terminalPanel).toEqual({
      activeSubId: "agent-bash",
    });
  });

  it("returns window record, state, and canvas for read queries", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.nativeWindowsRef.current.set("Workpad", record);

    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "get",
        mutationId: "m-get",
        args: { id: "Workpad" },
      },
      ctx,
    );
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "get_state",
        mutationId: "m-state",
        args: { id: "Workpad" },
      },
      ctx,
    );
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "get_canvas",
        mutationId: "m-canvas",
        args: { id: "Workpad" },
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-get",
        true,
        undefined,
        record,
      ),
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m-state",
      true,
      undefined,
      record.state,
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m-canvas",
      true,
      undefined,
      { components: record.components },
    );
  });

  it("lists windows as a plain record array", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce([record]);
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "list",
        mutationId: "m-list",
        args: {},
      },
      ctx,
    );
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m-list",
        true,
        undefined,
        [record],
      ),
    );
    expect(ctx.nativeWindowsRef.current.get("Workpad")).toEqual(record);
  });

  it("writes window-local state with JSON Pointer", async () => {
    const { ctx } = buildHandlerFixture();
    ctx.nativeWindowsRef.current.set("Workpad", record);
    harness.invoke.mockImplementation((_cmd, args) =>
      Promise.resolve(args.record),
    );
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "set_state",
        mutationId: "m3",
        args: { id: "Workpad", path: "/nested/value", value: 42 },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("native_window_save_canvas", {
      record: {
        ...record,
        state: { count: 1, nested: { value: 42 } },
      },
    });
  });

  it("acks failure for missing windows", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(null);
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "clear_canvas",
        mutationId: "m4",
        args: { id: "Missing" },
      },
      ctx,
    );
    await vi.waitFor(() =>
      expect(mocks.ackMutation).toHaveBeenCalledWith(
        "m4",
        false,
        "window not found: Missing",
      ),
    );
  });
});
