import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLayoutPrefs,
  layoutPrefsFromState,
  loadLayoutPrefsSync,
  mergeLayoutPrefsIntoState,
  resetLayoutPrefsInState,
  saveLayoutPrefs,
} from "./layoutPrefs";

describe("layoutPrefs", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          store.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          store.delete(key);
        }),
        clear: vi.fn(() => {
          store.clear();
        }),
      },
    });
  });

  it("extracts durable chrome layout prefs even when no tabs exist", () => {
    const prefs = layoutPrefsFromState({
      tabs: [],
      layout: {
        sidebarVisible: false,
        filesSidebarVisible: true,
        columns: "302px minmax(0,1fr) 480px",
        lastLeftWidth: "302px",
        lastRightWidth: "480px",
        areas: ["header header", "canvas files-sidebar"],
      },
      terminalPanel: { activeSubId: "agent-bash", height: 360 },
    });
    expect(prefs).toEqual({
      layout: {
        sidebarVisible: false,
        filesSidebarVisible: true,
        columns: "302px minmax(0,1fr) 480px",
        lastLeftWidth: "302px",
        lastRightWidth: "480px",
      },
      terminalPanel: { height: 360 },
    });
  });

  it("saves and synchronously reloads layout prefs from localStorage", async () => {
    const writer = vi.fn(() => Promise.resolve(true));
    await saveLayoutPrefs(
      {
        layout: { columns: "260px minmax(0,1fr) 420px" },
        terminalPanel: { height: 280 },
      },
      writer,
    );
    expect(writer).toHaveBeenCalledWith(
      "layout_prefs",
      expect.stringContaining("420px"),
    );
    expect(loadLayoutPrefsSync()).toEqual({
      layout: { columns: "260px minmax(0,1fr) 420px" },
      terminalPanel: { height: 280 },
    });
  });

  it("merges loaded prefs into existing state without dropping other keys", () => {
    const next = mergeLayoutPrefsIntoState(
      {
        layout: { rows: "38px minmax(0,1fr)", columns: "220px minmax(0,1fr)" },
        terminal: { open: true },
        terminalPanel: { activeSubId: "agent-bash" },
      },
      {
        layout: { columns: "300px minmax(0,1fr) 500px" },
        terminalPanel: { height: 410 },
      },
    );
    expect(next).toEqual({
      layout: {
        rows: "38px 38px minmax(0,1fr) 410px auto auto",
        columns: "300px minmax(0,1fr) 500px",
        areas: [
          "sidebar header files-sidebar",
          "sidebar tabs files-sidebar",
          "sidebar canvas files-sidebar",
          "sidebar terminal files-sidebar",
          "sidebar composer files-sidebar",
          "status status status",
        ],
      },
      terminal: { open: true },
      terminalPanel: { activeSubId: "agent-bash", height: 410 },
    });
  });

  it("clears prefs and resets state to workstation defaults", async () => {
    const writer = vi.fn(() => Promise.resolve(true));
    await saveLayoutPrefs(
      {
        layout: { columns: "300px minmax(0,1fr) 500px" },
        terminalPanel: { height: 410 },
      },
      writer,
    );
    await clearLayoutPrefs(writer);
    expect(loadLayoutPrefsSync()).toBeNull();
    expect(writer).toHaveBeenLastCalledWith("layout_prefs", "");

    const next = resetLayoutPrefsInState({
      layout: { rows: "38px minmax(0,1fr)", columns: "300px minmax(0,1fr)" },
      terminalPanel: { activeSubId: "agent-bash", height: 410 },
    });
    expect(next.layout).toEqual(
      expect.objectContaining({
        columns: "220px minmax(0,1fr) 360px",
        rows: "38px 38px minmax(0,1fr) 0px auto auto",
        sidebarVisible: true,
        filesSidebarVisible: true,
        areas: [
          "sidebar header files-sidebar",
          "sidebar tabs files-sidebar",
          "sidebar canvas files-sidebar",
          "sidebar terminal files-sidebar",
          "sidebar composer files-sidebar",
          "status status status",
        ],
      }),
    );
    expect(next.terminalPanel).toEqual({ activeSubId: "agent-bash" });
  });
});
