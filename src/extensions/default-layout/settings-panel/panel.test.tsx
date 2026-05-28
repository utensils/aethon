// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "./panel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("../../../config", () => ({
  getConfig: vi.fn(() =>
    Promise.resolve({
      ui: {
        theme: "ember",
        fontSize: 14,
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
      voice: { toggleHotkey: "mod+shift+m", holdHotkey: "AltRight" },
      updates: { channel: "stable", disableAutoCheck: false },
      devshell: {
        enabled: "auto",
        mode: "auto",
        cacheTtlHours: 720,
        refreshOnLockfileChange: true,
      },
    }),
  ),
}));

vi.mock("../../../services/voice", () => ({
  listVoiceProviders: vi.fn(() => Promise.resolve([])),
  prepareVoiceProvider: vi.fn(),
  removeVoiceProviderModel: vi.fn(),
  setSelectedVoiceProvider: vi.fn(),
  setVoiceProviderEnabled: vi.fn(),
}));

describe("SettingsPanel", () => {
  beforeEach(() => {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    };
    window.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => cleanup());

  it("renders as a live settings dialog without a save footer or stale save copy", async () => {
    render(
      <SettingsPanel
        component={{ id: "settings-panel", type: "settings-panel" }}
        state={{
          settings: { open: true, pending: null, saveStatus: "saved" },
          sidebar: { models: [] },
        }}
        onEvent={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.classList.contains("ae-settings-panel")).toBe(true);

    await waitFor(() => {
      expect(screen.getByLabelText("Theme")).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByText(/Save button/i)).toBeNull();
    expect(
      screen.getByText("Saved").classList.contains("ae-settings-save-state"),
    ).toBe(true);
  });
});
