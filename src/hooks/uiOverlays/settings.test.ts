// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useSettingsOverlay, SETTINGS_AUTOSAVE_DELAY_MS } from "./settings";
import type { UseUiOverlaysContext } from "./types";
import { clearConfigCache, getConfig, type AethonConfig } from "../../config";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../config", () => ({
  clearConfigCache: vi.fn(),
  getConfig: vi.fn(),
}));

const baseConfig: AethonConfig = {
  ui: {
    theme: "ember",
    fontSize: 14,
    restoreTabs: false,
    notifyOnCompletion: true,
    notifyMinDurationSeconds: 8,
    thinkingVisibility: "show",
    toolCallsVisibility: "show",
  },
  agent: {
    model: "openai/gpt-5.5",
    providerTimeoutSeconds: null,
    codexFastMode: false,
    bashTimeoutFloorSeconds: 300,
    subagentTimeoutSeconds: 300,
  },
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
  updates: { channel: "nightly", disableAutoCheck: false },
  devshell: {
    enabled: "auto",
    mode: "auto",
    cacheTtlHours: 720,
    refreshOnLockfileChange: true,
  },
  guardrails: { softPromptAnchor: null, hardEnforceProjectRoot: false },
};

function buildContext(initialState: Record<string, unknown>): {
  ctx: Pick<
    UseUiOverlaysContext,
    "setState" | "stateRef" | "reapplyConfig" | "pushNotification"
  >;
  stateRef: MutableRefObject<Record<string, unknown>>;
} {
  const stateRef: MutableRefObject<Record<string, unknown>> = {
    current: initialState,
  };
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (arg) => {
    stateRef.current = typeof arg === "function" ? arg(stateRef.current) : arg;
  };
  return {
    stateRef,
    ctx: {
      setState,
      stateRef,
      reapplyConfig: vi.fn(),
      pushNotification: vi.fn(),
    },
  };
}

describe("useSettingsOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(getConfig).mockReset();
    vi.mocked(getConfig).mockResolvedValue(baseConfig);
    vi.mocked(clearConfigCache).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the focused settings section while applying pending patches", () => {
    const { ctx, stateRef } = buildContext({
      settings: {
        open: true,
        pending: null,
        focusSection: "extensions",
      },
    });

    const { result } = renderHook(() => useSettingsOverlay(ctx));

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "aether" } });
    });

    expect(stateRef.current.settings).toEqual({
      open: true,
      pending: { ui: { theme: "aether" } },
      focusSection: "extensions",
      saveStatus: "saving",
      saveError: null,
    });
  });

  it("debounces live settings writes and persists the latest merged config", async () => {
    const { ctx } = buildContext({
      settings: { open: true, pending: null, focusSection: "appearance" },
    });
    const { result } = renderHook(() => useSettingsOverlay(ctx));

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "aether" } });
      result.current.applySettingsPatch({
        ui: { theme: "aether", fontSize: 18 },
      });
    });

    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalledWith("write_config", expect.anything());

    await vi.advanceTimersByTimeAsync(1);

    const writeCalls = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === "write_config");
    expect(writeCalls).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("write_config", {
      config: expect.objectContaining({
        ui: expect.objectContaining({ theme: "aether", fontSize: 18 }),
        shortcuts: baseConfig.shortcuts,
        updates: baseConfig.updates,
        voice: baseConfig.voice,
        devshell: baseConfig.devshell,
      }),
    });
    expect(invoke).toHaveBeenCalledWith("agent_broadcast_command", {
      payload: expect.stringContaining("runtime_config_changed"),
    });
  });

  it("reapplies fresh config after autosave without closing settings", async () => {
    const fresh = {
      ...baseConfig,
      ui: { ...baseConfig.ui, theme: "brink" },
    };
    vi.mocked(getConfig)
      .mockResolvedValueOnce(baseConfig)
      .mockResolvedValueOnce(fresh);
    const { ctx, stateRef } = buildContext({
      settings: { open: true, pending: null, focusSection: null },
    });
    const { result } = renderHook(() => useSettingsOverlay(ctx));

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "brink" } });
    });
    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS);

    expect(clearConfigCache).toHaveBeenCalledTimes(1);
    expect(ctx.reapplyConfig).toHaveBeenCalledWith(fresh);
    expect(stateRef.current.settings).toEqual({
      open: true,
      pending: { ui: { theme: "brink" } },
      focusSection: null,
      saveStatus: "saved",
      saveError: null,
    });
  });

  it("keeps the dialog open and the current edits visible when autosave fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    const { ctx, stateRef } = buildContext({
      settings: { open: true, pending: null, focusSection: null },
    });
    const { result } = renderHook(() => useSettingsOverlay(ctx));

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "paper" } });
    });
    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS);

    expect(ctx.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ae-settings-save-failed",
        title: "Failed to save settings",
        kind: "error",
      }),
    );
    expect(stateRef.current.settings).toEqual({
      open: true,
      pending: { ui: { theme: "paper" } },
      focusSection: null,
      saveStatus: "error",
      saveError: "Error: disk full",
    });
  });

  it("reopens settings with current edits when a close-triggered flush fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("permission denied"));
    const { ctx, stateRef } = buildContext({
      settings: {
        open: true,
        pending: { ui: { theme: "aether" } },
        focusSection: "appearance",
        saveStatus: "saving",
        saveError: null,
      },
    });
    const { result } = renderHook(() => useSettingsOverlay(ctx));

    await act(async () => {
      result.current.closeSettings();
      await Promise.resolve();
    });

    expect(ctx.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ae-settings-save-failed",
        title: "Failed to save settings",
        kind: "error",
      }),
    );
    expect(stateRef.current.settings).toEqual({
      open: true,
      pending: { ui: { theme: "aether" } },
      focusSection: "appearance",
      saveStatus: "error",
      saveError: "Error: permission denied",
    });
  });

  it("serializes overlapping autosaves so older writes cannot overwrite newer edits", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve(undefined);
          }),
      )
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = () => resolve(undefined);
          }),
      );
    const { ctx } = buildContext({
      settings: { open: true, pending: null, focusSection: null },
    });
    const { result } = renderHook(() => useSettingsOverlay(ctx));

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "paper" } });
    });
    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS);

    act(() => {
      result.current.applySettingsPatch({ ui: { theme: "brink" } });
    });
    await vi.advanceTimersByTimeAsync(SETTINGS_AUTOSAVE_DELAY_MS);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "write_config", {
      config: expect.objectContaining({
        ui: expect.objectContaining({ theme: "paper" }),
      }),
    });

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(2, "agent_broadcast_command", {
      payload: expect.stringContaining("runtime_config_changed"),
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "write_config", {
      config: expect.objectContaining({
        ui: expect.objectContaining({ theme: "brink" }),
      }),
    });

    await act(async () => {
      resolveSecond?.();
      await Promise.resolve();
    });
  });
});
