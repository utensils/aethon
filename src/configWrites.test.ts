// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildConfigWritePayload,
  CONFIG_WRITE_SECTIONS,
  mergeConfigPatch,
  writeConfigPatch,
} from "./configWrites";
import { clearConfigCache, getConfig, type AethonConfig } from "./config";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const liveConfig: AethonConfig = {
  ui: {
    theme: "ember",
    fontSize: 14,
    restoreTabs: false,
    notifyOnCompletion: true,
    notifyMinDurationSeconds: 8,
    thinkingVisibility: "show",
    toolCallsVisibility: "hide",
  },
  agent: {
    model: "openai/gpt-5.5",
    thinkingLevel: "medium",
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
  startup: { autoApprove: true },
  guardrails: { softPromptAnchor: "stay inside repo", hardEnforceProjectRoot: true },
};

afterEach(() => {
  invokeMock.mockReset();
  clearConfigCache();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("config write payload helpers", () => {
  it("preserves every known config section while applying nested patches", () => {
    const payload = buildConfigWritePayload(liveConfig, {
      ui: { theme: "brink" },
      agent: { model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
    });

    expect(Object.keys(payload)).toEqual([...CONFIG_WRITE_SECTIONS]);
    expect(payload).toMatchObject({
      ui: { ...liveConfig.ui, theme: "brink" },
      agent: {
        ...liveConfig.agent,
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
      },
      shell: liveConfig.shell,
      shortcuts: liveConfig.shortcuts,
      voice: liveConfig.voice,
      updates: liveConfig.updates,
      devshell: liveConfig.devshell,
      startup: liveConfig.startup,
      guardrails: liveConfig.guardrails,
    });
  });

  it("keeps null values in patches meaningful", () => {
    const payload = buildConfigWritePayload(liveConfig, {
      agent: { model: null, thinkingLevel: null },
      guardrails: { softPromptAnchor: null },
    });

    expect(payload.agent.model).toBeNull();
    expect(payload.agent.thinkingLevel).toBeNull();
    expect(payload.guardrails.softPromptAnchor).toBeNull();
  });

  it("can build a destructive-write-safe payload when the live read fails", () => {
    const payload = buildConfigWritePayload(null, {
      startup: { autoApprove: false },
    });

    expect(Object.keys(payload)).toEqual([...CONFIG_WRITE_SECTIONS]);
    expect(payload.startup).toEqual({ autoApprove: false });
    expect(payload.ui).toEqual({});
    expect(payload.guardrails).toEqual({});
  });

  it("writeConfigPatch reads through stale cache before destructive writes", async () => {
    const cachedConfig: AethonConfig = {
      ...liveConfig,
      updates: { channel: "stable", disableAutoCheck: false },
    };
    const currentConfig: AethonConfig = {
      ...liveConfig,
      updates: { channel: "nightly", disableAutoCheck: true },
      voice: { ...liveConfig.voice, speakMaxChars: 2400 },
    };
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock
      .mockResolvedValueOnce(cachedConfig)
      .mockResolvedValueOnce(currentConfig)
      .mockResolvedValueOnce(undefined);

    await getConfig();
    await writeConfigPatch({ startup: { autoApprove: false } });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_config");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_config");
    expect(invokeMock).toHaveBeenNthCalledWith(3, "write_config", {
      config: expect.objectContaining({
        updates: currentConfig.updates,
        voice: currentConfig.voice,
        startup: { autoApprove: false },
      }),
    });
  });

  it("merges pending patches one top-level section at a time", () => {
    expect(
      mergeConfigPatch(
        { ui: { theme: "ember" }, agent: { model: "old" } },
        { ui: { fontSize: 16 }, agent: { model: null } },
      ),
    ).toEqual({
      ui: { theme: "ember", fontSize: 16 },
      agent: { model: null },
    });
  });
});
