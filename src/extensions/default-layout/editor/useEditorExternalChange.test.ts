// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri mocks: invoke returns a controllable mtime for fs_file_mtime;
// listen records callbacks so the test can fire fs-tree-changed.
const eventListeners = new Map<
  string,
  Array<(event: { payload: unknown }) => void>
>();
let mtime = 100;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    Promise.resolve(cmd === "fs_file_mtime" ? mtime : null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: <T,>(event: string, cb: (e: { payload: T }) => void) => {
    const list = eventListeners.get(event) ?? [];
    list.push(cb as (event: { payload: unknown }) => void);
    eventListeners.set(event, list);
    return Promise.resolve(() => {
      const next = (eventListeners.get(event) ?? []).filter((fn) => fn !== cb);
      eventListeners.set(event, next);
    });
  },
}));

// Buffer cache mock — the hook stores its baseline + warning flag on the
// buffer so they survive a tab switch. Tests seed/inspect via this map.
interface TestBuffer {
  externalBaselineMtime?: number;
  externalChanged?: boolean;
}
const buffers = new Map<string, TestBuffer>();
vi.mock("../../../monaco/editor-buffers", () => ({
  getEditorBuffer: (id: string) => buffers.get(id),
}));

function fire(payload: { root: string; dirs: string[] }): void {
  for (const cb of eventListeners.get("fs-tree-changed") ?? []) cb({ payload });
}

const ARGS = {
  tabId: "ed-1",
  filePath: "/repo/src/App.tsx",
  root: "/repo",
};

beforeEach(() => {
  eventListeners.clear();
  buffers.clear();
  buffers.set("ed-1", {});
  mtime = 100;
});
afterEach(() => {
  // Unmount hooks so their window 'focus' listeners + poll intervals don't
  // leak into the next test (a stale checkNow would race the shared buffer).
  cleanup();
  vi.clearAllMocks();
});

async function setup(isDirty: boolean, reload = vi.fn()) {
  const isDirtyRef = { current: isDirty };
  const { useEditorExternalChange } = await import("./useEditorExternalChange");
  const hook = renderHook(() =>
    useEditorExternalChange({ ...ARGS, isDirtyRef, reload }),
  );
  // Wait for the initial baseline capture to land (mtime=100) before the
  // test mutates mtime — otherwise the async capture could read the new
  // value and mask the change.
  await waitFor(() =>
    expect(buffers.get("ed-1")?.externalBaselineMtime).toBe(100),
  );
  return { hook, reload, isDirtyRef };
}

describe("useEditorExternalChange", () => {
  it("silently reloads a clean buffer when the file changes on disk", async () => {
    const { hook, reload } = await setup(false);
    mtime = 200; // file changed on disk
    await act(async () => {
      fire({ root: "/repo", dirs: ["/repo/src"] });
      await Promise.resolve();
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(hook.result.current.externalChanged).toBe(false);
  });

  it("flags a dirty buffer instead of reloading", async () => {
    const { hook, reload } = await setup(true);
    mtime = 200;
    await act(async () => {
      fire({ root: "/repo", dirs: ["/repo/src"] });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(hook.result.current.externalChanged).toBe(true),
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores events for unrelated directories", async () => {
    const { hook, reload } = await setup(false);
    mtime = 200;
    await act(async () => {
      fire({ root: "/repo", dirs: ["/repo/other"] });
      await Promise.resolve();
    });
    expect(reload).not.toHaveBeenCalled();
    expect(hook.result.current.externalChanged).toBe(false);
  });

  it("detects an external edit on window focus (collapsed-folder case)", async () => {
    const { hook, reload } = await setup(false);
    mtime = 200; // changed on disk while its folder was never watched
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(hook.result.current.externalChanged).toBe(false);
  });

  it("keeps the warning on the buffer across a dirty tab round-trip", async () => {
    const isDirtyRef = { current: true };
    const reload = vi.fn();
    const { useEditorExternalChange } = await import(
      "./useEditorExternalChange"
    );
    const hook = renderHook(
      ({ tabId }: { tabId: string }) =>
        useEditorExternalChange({
          tabId,
          filePath: ARGS.filePath,
          root: ARGS.root,
          isDirtyRef,
          reload,
        }),
      { initialProps: { tabId: "ed-1" } },
    );
    await waitFor(() =>
      expect(buffers.get("ed-1")?.externalBaselineMtime).toBe(100),
    );

    // External edit under a dirty buffer → flagged + stored on the buffer.
    mtime = 200;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.externalChanged).toBe(true));
    expect(buffers.get("ed-1")?.externalChanged).toBe(true);

    // Switch to another tab, then back — the warning must persist and the
    // buffer must NOT be silently re-baselined/reloaded.
    buffers.set("ed-2", {});
    act(() => hook.rerender({ tabId: "ed-2" }));
    act(() => hook.rerender({ tabId: "ed-1" }));
    await waitFor(() => expect(hook.result.current.externalChanged).toBe(true));
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloadExternal reloads and clears the flag", async () => {
    const { hook, reload } = await setup(true);
    mtime = 200;
    await act(async () => {
      fire({ root: "/repo", dirs: ["/repo/src"] });
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.externalChanged).toBe(true));
    await act(async () => {
      hook.result.current.reloadExternal();
      await Promise.resolve();
    });
    expect(reload).toHaveBeenCalled();
    await waitFor(() =>
      expect(hook.result.current.externalChanged).toBe(false),
    );
  });
});
