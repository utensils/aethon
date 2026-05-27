import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps } from "../dispatcherTypes";
import {
  authProfileServicesForTab,
  defaultProfileIdForTab,
  handleAuthProfileMessage,
} from "./manager";
import {
  createProfileMeta,
  loadAuthProfilesState,
  upsertProfileMeta,
} from "./store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempUserDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aethon-auth-manager-"));
  tempDirs.push(dir);
  return dir;
}

function makeState(userDir = tempUserDir()): AethonAgentState {
  const authStorage = AuthStorage.inMemory();
  return {
    userDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    settingsManager: SettingsManager.inMemory(),
    authProfiles: loadAuthProfilesState(userDir),
    authProfileServices: new Map(),
    tabAuthProfileIds: new Map(),
  } as unknown as AethonAgentState;
}

function addProfile(
  state: AethonAgentState,
  providerId: string,
  label = providerId,
): string {
  const profile = createProfileMeta(state.authProfiles, {
    providerId,
    label,
    kind: "oauth",
    now: 1,
  });
  state.authProfiles = upsertProfileMeta(state.authProfiles, profile);
  state.authProfiles.defaultByProvider[providerId] = profile.id;
  return profile.id;
}

describe("auth profile manager", () => {
  it("applies the default auth profile for tabs opened without an explicit model", () => {
    const state = makeState();
    const profileId = addProfile(state, "anthropic", "Claude Pro");
    state.settingsManager.setDefaultProvider("anthropic");

    const services = authProfileServicesForTab(state, "default");

    expect(defaultProfileIdForTab(state)).toBe(profileId);
    expect(state.tabAuthProfileIds.get("default")).toBe(profileId);
    expect(services.authStorage).not.toBe(state.authStorage);
    expect(services.modelRegistry).not.toBe(state.modelRegistry);
  });

  it("uses the model provider default when a tab opens with an explicit model", () => {
    const state = makeState();
    const profileId = addProfile(state, "anthropic", "Claude Pro");
    const model = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    } as Model<Api>;

    expect(defaultProfileIdForTab(state, model)).toBe(profileId);
  });

  it("uses the only configured default when startup has no model or settings provider yet", () => {
    const state = makeState();
    const profileId = addProfile(state, "anthropic", "Claude Pro");

    expect(defaultProfileIdForTab(state)).toBe(profileId);
  });

  it("persists OAuth placeholder removal when login fails", async () => {
    const userDir = tempUserDir();
    const state = makeState(userDir);
    const sent: unknown[] = [];
    const deps = {
      send: (message: unknown) => sent.push(message),
    } as DispatcherDeps;

    await handleAuthProfileMessage(state, deps, {
      type: "auth_profile_login_start",
      providerId: "not-a-provider",
      label: "Broken OAuth",
    });

    await vi.waitFor(() => {
      expect(loadAuthProfilesState(userDir).profiles).toHaveLength(0);
    });
    expect(state.authProfiles.profiles).toHaveLength(0);
    expect(
      sent.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "auth_profile_login_event" &&
          (message as { event?: { ok?: boolean } }).event?.ok === false,
      ),
    ).toBe(true);
  });
});
