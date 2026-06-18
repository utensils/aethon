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
    handleNativeWindowQuery(
      {
        type: "native_window_query",
        op: "clear_canvas",
        mutationId: "m4",
        args: { id: "Missing" },
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m4",
      false,
      "window not found: Missing",
    );
  });
});
