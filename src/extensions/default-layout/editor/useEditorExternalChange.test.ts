// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
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
  mtime = 100;
});
afterEach(() => vi.clearAllMocks());

async function setup(isDirty: boolean, reload = vi.fn()) {
  const isDirtyRef = { current: isDirty };
  const { useEditorExternalChange } = await import("./useEditorExternalChange");
  const hook = renderHook(() =>
    useEditorExternalChange({ ...ARGS, isDirtyRef, reload }),
  );
  // Let the initial captureBaseline (mtime=100) settle.
  await waitFor(() =>
    expect(eventListeners.get("fs-tree-changed")?.length).toBeGreaterThan(0),
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
