// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, type AethonConfig } from "../config";
import { readState, writeState } from "../persist";
import { createAppStore } from "../state/appStore";
import { useSessionPersistence } from "./useSessionPersistence";

vi.mock("../config", () => ({
  getConfig: vi.fn(),
}));

vi.mock("../persist", () => ({
  readState: vi.fn(),
  writeState: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../layoutPrefs", () => ({
  loadLayoutPrefsFromDisk: vi.fn(() => Promise.resolve(null)),
  loadLayoutPrefsSync: vi.fn(() => null),
  mergeLayoutPrefsIntoState: vi.fn((state) => state),
  saveLayoutPrefs: vi.fn(() => Promise.resolve()),
}));

const defaultConfig: AethonConfig = {
  ui: {
    theme: null,
    fontSize: null,
    restoreTabs: false,
    notifyOnCompletion: true,
    notifyMinDurationSeconds: 8,
  },
  agent: { model: null },
  shell: {
    defaultShareMode: "private",
    autoRestartAgent: true,
    defaultCommand: null,
    defaultArgs: [],
    inheritEnv: true,
    promptBeforeClose: true,
  },
  shortcuts: { newTabKind: "agent" },
  voice: {
    toggleHotkey: "mod+shift+m",
    holdHotkey: null,
  },
  updates: { channel: "stable", disableAutoCheck: false },
  devshell: {
    enabled: "auto",
    mode: "auto",
    cacheTtlHours: 720,
    refreshOnLockfileChange: true,
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSessionPersistence", () => {
  it("does not restore durable session snapshots when restore_tabs is disabled", async () => {
    vi.mocked(getConfig).mockResolvedValue(defaultConfig);
    vi.mocked(readState).mockResolvedValue(
      JSON.stringify({
        tabs: [
          {
            id: "stale-tab",
            label: "Stale",
            messages: [{ id: "m1", role: "user", text: "old context" }],
          },
        ],
        activeTabId: "stale-tab",
        savedAt: 1,
      }),
    );
    const appStore = createAppStore({
      tabs: [],
      activeTabId: null,
      layout: {},
      terminalPanel: {},
    });

    renderHook(() =>
      useSessionPersistence({
        appStore,
        hasSyncSessionSnapshot: false,
      }),
    );

    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(readState).not.toHaveBeenCalled();
    expect(appStore.getState().tabs).toEqual([]);
  });

  it("restores durable session snapshots when restore_tabs is enabled", async () => {
    vi.mocked(getConfig).mockResolvedValue({
      ...defaultConfig,
      ui: { ...defaultConfig.ui, restoreTabs: true },
    });
    vi.mocked(readState).mockResolvedValue(
      JSON.stringify({
        tabs: [
          {
            id: "restored-tab",
            label: "Restored",
            messages: [{ id: "m1", role: "user", text: "old context" }],
          },
        ],
        activeTabId: "restored-tab",
        savedAt: 1,
      }),
    );
    const appStore = createAppStore({
      tabs: [],
      activeTabId: null,
      layout: {},
      terminalPanel: {},
    });

    renderHook(() =>
      useSessionPersistence({
        appStore,
        hasSyncSessionSnapshot: false,
      }),
    );

    await waitFor(() => {
      expect(appStore.getState().activeTabId).toBe("restored-tab");
    });
    expect(readState).toHaveBeenCalledWith("session_ui_snapshot");
    expect(writeState).toHaveBeenCalled();
  });
});
