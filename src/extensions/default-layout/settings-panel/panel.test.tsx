// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "./panel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../../config", () => ({
  DEFAULT_AGENT_TIMEOUT_SECONDS: 300,
  MAX_AGENT_TIMEOUT_SECONDS: 24 * 60 * 60,
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

  it("routes Open config.toml through the settings event route", async () => {
    const onEvent = vi.fn();
    render(
      <SettingsPanel
        component={{ id: "settings-panel", type: "settings-panel" }}
        state={{
          settings: { open: true, pending: null, saveStatus: "idle" },
          sidebar: { models: [] },
        }}
        onEvent={onEvent}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open config.toml" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open config.toml" }));
    expect(onEvent).toHaveBeenCalledWith("open-config-file");
  });

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
