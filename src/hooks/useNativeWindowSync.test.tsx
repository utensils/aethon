// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../types/tab";
import type { NativeCanvasWindowRecord } from "../nativeWindows";
import { useNativeWindowSync } from "./useNativeWindowSync";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
const listen = vi.fn((event: string, cb: (event: { payload: unknown }) => void) => {
  listeners.set(event, cb);
  return Promise.resolve(unlisten);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (event: { payload: unknown }) => void) =>
    listen(event, cb),
}));

const record = (id: string, ownedShellTabIds: string[] = []): NativeCanvasWindowRecord => ({
  id,
  label: id,
  kind: "canvas",
  title: id,
  restoreOnLaunch: false,
  components: [],
  state: { ownedShellTabIds },
});

const shellTab = (id: string): Tab =>
  ({
    id,
    kind: "shell",
    label: id,
    shell: { shareMode: "private" },
  }) as Tab;

function statefulSetState(seed: Record<string, unknown>) {
  let state = seed;
  const setState = vi.fn((updater: unknown) => {
    state =
      typeof updater === "function"
        ? (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(
            state,
          )
        : (updater as Record<string, unknown>);
  });
  return { setState, getState: () => state };
}

describe("useNativeWindowSync", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockClear();
    unlisten.mockClear();
    listeners.clear();
    invoke.mockImplementation((cmd) => {
      if (cmd === "native_window_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("mirrors initial native window records into app state", async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === "native_window_list") return Promise.resolve([record("Win")]);
      return Promise.resolve(undefined);
    });
    const store = statefulSetState({ keep: true });
    const nativeWindowsRef = { current: new Map<string, NativeCanvasWindowRecord>() };

    renderHook(() =>
      useNativeWindowSync({ setState: store.setState, nativeWindowsRef }),
    );

    await waitFor(() =>
      expect(store.getState().nativeWindows).toEqual([
        {
          id: "Win",
          label: "Win",
          kind: "canvas",
          title: "Win",
          restoreOnLaunch: false,
          componentCount: 0,
        },
      ]),
    );
    expect(nativeWindowsRef.current.has("Win")).toBe(true);
  });

  it("updates records from native-window-record events", async () => {
    const store = statefulSetState({});
    const nativeWindowsRef = { current: new Map<string, NativeCanvasWindowRecord>() };

    renderHook(() =>
      useNativeWindowSync({ setState: store.setState, nativeWindowsRef }),
    );
    await waitFor(() => expect(listen).toHaveBeenCalled());

    listeners.get("native-window-record")?.({ payload: record("Live") });

    expect(store.getState().nativeWindows).toEqual([
      {
        id: "Live",
        label: "Live",
        kind: "canvas",
        title: "Live",
        restoreOnLaunch: false,
        componentCount: 0,
      },
    ]);
  });

  it("cleans up owned shell tabs when a native terminal window closes best-effort", async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === "native_window_list") {
        return Promise.resolve([record("Term", ["owned", "owned"])]);
      }
      if (cmd === "shell_close") return Promise.reject(new Error("already gone"));
      return Promise.resolve(undefined);
    });
    const store = statefulSetState({
      tabs: [shellTab("owned"), shellTab("kept")],
      terminalPanel: { activeSubId: "owned" },
    });
    const nativeWindowsRef = {
      current: new Map<string, NativeCanvasWindowRecord>([
        ["Term", record("Term", ["owned", "owned"])],
      ]),
    };

    renderHook(() =>
      useNativeWindowSync({ setState: store.setState, nativeWindowsRef }),
    );
    await waitFor(() => expect(listen).toHaveBeenCalled());

    listeners.get("native-window-closed")?.({ payload: { id: "Term" } });

    expect(invoke).toHaveBeenCalledWith("shell_close", { tabId: "owned" });
    expect((store.getState().tabs as Tab[]).map((tab) => tab.id)).toEqual([
      "kept",
    ]);
    expect(store.getState().terminalPanel).toEqual({ activeSubId: "agent-bash" });
    expect(nativeWindowsRef.current.has("Term")).toBe(false);
  });
});
