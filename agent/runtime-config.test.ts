import { describe, expect, it, vi } from "vitest";
import type { AethonAgentState } from "./state";
import {
  applyBashTimeoutFloor,
  applyProviderTimeoutOverride,
  applyRuntimeConfig,
  runtimeConfigFromConfig,
  runtimeConfigFromEnv,
} from "./runtime-config";

describe("runtimeConfigFromEnv", () => {
  it("normalizes timeout env vars", () => {
    expect(
      runtimeConfigFromEnv({
        AETHON_PROVIDER_TIMEOUT_SECONDS: "12",
        AETHON_BASH_TIMEOUT_FLOOR_SECONDS: "30",
        AETHON_SUBAGENT_TIMEOUT_SECONDS: "60",
      }),
    ).toEqual({
      providerTimeoutMs: 12000,
      bashTimeoutFloorSeconds: 30,
      subagentTimeoutSeconds: 60,
    });
  });

  it("floors fractional timeout env vars to at least one second", () => {
    expect(
      runtimeConfigFromEnv({
        AETHON_PROVIDER_TIMEOUT_SECONDS: "0.5",
        AETHON_BASH_TIMEOUT_FLOOR_SECONDS: "0.5",
        AETHON_SUBAGENT_TIMEOUT_SECONDS: "0.5",
      }),
    ).toEqual({
      providerTimeoutMs: 1000,
      bashTimeoutFloorSeconds: 1,
      subagentTimeoutSeconds: 1,
    });
  });

  it("keeps provider unset and uses defaults for invalid values", () => {
    expect(runtimeConfigFromEnv({})).toEqual({
      providerTimeoutMs: undefined,
      bashTimeoutFloorSeconds: 300,
      subagentTimeoutSeconds: 300,
    });
  });
});

describe("runtimeConfigFromConfig", () => {
  it("maps settings config seconds into bridge runtime config", () => {
    expect(
      runtimeConfigFromConfig({
        agent: {
          providerTimeoutSeconds: 10,
          bashTimeoutFloorSeconds: 20,
          subagentTimeoutSeconds: 30,
        },
      }),
    ).toEqual({
      providerTimeoutMs: 10000,
      bashTimeoutFloorSeconds: 20,
      subagentTimeoutSeconds: 30,
    });
  });
});

describe("applyProviderTimeoutOverride", () => {
  it("applies a provider retry timeout override without replacing pi methods", () => {
    const getProviderRetrySettings = vi.fn(() => ({
      timeoutMs: 300000,
      maxRetries: 2,
      maxRetryDelayMs: 60000,
    }));
    const applyOverrides = vi.fn();
    const state = {
      providerTimeoutMs: 12000,
      settingsManager: { getProviderRetrySettings, applyOverrides },
    } as unknown as AethonAgentState;
    applyProviderTimeoutOverride(state);
    expect(applyOverrides).toHaveBeenLastCalledWith({
      retry: {
        provider: {
          timeoutMs: 12000,
          maxRetries: 2,
          maxRetryDelayMs: 60000,
        },
      },
    });
    applyRuntimeConfig(state, {
      providerTimeoutMs: undefined,
      bashTimeoutFloorSeconds: 300,
      subagentTimeoutSeconds: 300,
    });
    applyProviderTimeoutOverride(state);
    expect(applyOverrides).toHaveBeenLastCalledWith({
      retry: {
        provider: {
          timeoutMs: 300000,
          maxRetries: 2,
          maxRetryDelayMs: 60000,
        },
      },
    });
  });
});

describe("applyBashTimeoutFloor", () => {
  it("raises shorter explicit bash timeouts to the configured floor", () => {
    expect(applyBashTimeoutFloor({ timeout: 30 }, 300)).toEqual({
      timeout: 300,
    });
  });

  it("keeps longer or absent timeouts unchanged", () => {
    const absent = { command: "pwd" };
    expect(applyBashTimeoutFloor({ timeout: 600 }, 300)).toEqual({
      timeout: 600,
    });
    expect(applyBashTimeoutFloor(absent, 300)).toBe(absent);
  });
});
