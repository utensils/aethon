// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPanel } from "./panel";
import { listVoiceProviders } from "../../../services/voice";
import type { VoiceDownloadProgress, VoiceProviderInfo } from "../../../types/voice";

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
      voice: {
        toggleHotkey: "mod+shift+m",
        holdHotkey: "AltRight",
        speakAgentReplies: false,
        speakMaxChars: 600,
        conversationContinuous: false,
      },
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

const baseVoiceProvider: VoiceProviderInfo = {
  id: "voice-lfm2",
  name: "LFM2 Audio",
  description: "Local transcription and speech",
  kind: "local-model",
  recordingMode: "native",
  privacyLabel: "Offline",
  offline: true,
  downloadRequired: true,
  modelSizeLabel: "1.2 GB",
  cachePath: "/tmp/model.bin",
  acceleratorLabel: "Metal",
  status: "ready",
  statusLabel: "Ready",
  enabled: true,
  selected: true,
  setupRequired: true,
  canRemoveModel: true,
  error: null,
};

function renderSettings(state: Record<string, unknown> = {}) {
  return render(
    <SettingsPanel
      component={{ id: "settings-panel", type: "settings-panel" }}
      state={{
        settings: { open: true, pending: null, saveStatus: "idle" },
        sidebar: { models: [] },
        ...state,
      }}
      onEvent={vi.fn()}
    />,
  );
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    };
    window.cancelAnimationFrame = vi.fn();
    vi.mocked(listVoiceProviders).mockResolvedValue([]);
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

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

  it("renders voice provider loading and error states", async () => {
    vi.mocked(listVoiceProviders).mockRejectedValueOnce(new Error("voice boom"));
    renderSettings();

    await waitFor(() => {
      expect(screen.getByText("Loading voice providers...")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Error: voice boom")).toBeTruthy();
    });
  });

  it("renders voice provider download progress from Tauri events", async () => {
    let progressHandler:
      | ((event: { payload: VoiceDownloadProgress }) => void)
      | undefined;
    vi.mocked(listVoiceProviders).mockResolvedValue([baseVoiceProvider]);
    vi.mocked(listen).mockImplementation((event, handler) => {
      if (event === "voice-download-progress") {
        progressHandler = handler as typeof progressHandler;
      }
      return Promise.resolve(() => {});
    });

    renderSettings();

    await waitFor(() => {
      expect(screen.getByText("LFM2 Audio")).toBeTruthy();
    });

    act(() => {
      progressHandler?.({
        payload: {
          providerId: "voice-lfm2",
          filename: "model.bin",
          downloadedBytes: 50,
          totalBytes: 100,
          overallDownloadedBytes: 50,
          overallTotalBytes: 100,
          percent: 0.5,
        },
      });
    });

    expect(screen.getByText(/Downloading model\.bin:/)).toBeTruthy();
    expect(screen.getByText(/50%/)).toBeTruthy();
  });

  it("renders devshell refresh status and invokes refresh for the active root", async () => {
    renderSettings({
      devshell: {
        activeRoot: "/repo",
        entries: {
          "/repo": {
            state: "ready",
            kind: "nix",
            detectedKind: "flake",
            enabled: "auto",
            mode: "auto",
            varCount: 42,
          },
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Ready (nix, 42 vars)")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Refresh now"));
    expect(invoke).toHaveBeenCalledWith("devshell_refresh", {
      args: { root: "/repo" },
    });
  });
});
