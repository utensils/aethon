import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AethonAgentState, TabRecord } from "../state";
import type { DispatcherDeps } from "../dispatcherTypes";
import {
  authRefreshTabIds,
  authProfileServicesForTab,
  defaultProfileIdForTab,
  handleAuthProfileMessage,
  modelRegistryForModelId,
  parseIdTokenEmail,
  refreshAuthServicesForTab,
} from "./manager";
import {
  authProfileAuthPath,
  createProfileMeta,
  loadAuthProfilesState,
  saveAuthProfilesState,
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
    tabs: new Map(),
  } as unknown as AethonAgentState;
}

/**
 * Augment a bare {@link makeState} with the empty extension collections that
 * the `ready` handshake (`emitGlobalReady` → `emitReady`) serializes, so a
 * handler that ends by emitting `ready` can run without a half-built state.
 * Kept out of `makeState` so tests that deliberately rely on a minimal state
 * (e.g. forcing a session-refresh failure) are unaffected.
 */
function withReadyState(state: AethonAgentState): AethonAgentState {
  Object.assign(state as unknown as Record<string, unknown>, {
    tabProjectCwds: new Map(),
    cachedModels: [],
    extensionComponents: new Map(),
    extensionStateTree: {},
    extensionStateKeys: new Set(),
    perTabExtState: new Map(),
    extensionLayout: null,
    pendingLayoutPatches: [],
    extensionThemes: new Map(),
    extensionSlashCommands: new Map(),
    piSlashCommands: [],
    piSkills: [],
    extensionKeybindings: new Map(),
    extensionMenuItems: new Map(),
    extensionEventRoutes: new Map(),
    extensionLayouts: new Map(),
    extensionFrontendModules: new Map(),
    extensionHighlightGrammars: new Map(),
    loadedExtensions: new Map(),
    projectExtensionRoots: new Map(),
    loadFailures: new Map(),
    disabledExtensions: new Set(),
    disabledExtensionMeta: new Map(),
    discoveredTabs: [],
  });
  return state;
}

function fakeTab(model: string, promptInFlight = false): TabRecord {
  const [provider, ...rest] = model.split("/");
  return {
    id: "tab",
    session: {
      model: { provider, id: rest.join("/") },
    } as unknown as TabRecord["session"],
    toolArgsCache: new Map(),
    promptInFlight,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
  };
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

  it("falls back to the global model registry for stale or unsafe profile ids", () => {
    const state = makeState();
    state.tabAuthProfileIds.set("tab-1", "../escape");
    state.authProfiles.defaultByProvider.anthropic = "../escape";

    expect(modelRegistryForModelId(state, "tab-1", "anthropic/claude")).toBe(
      state.modelRegistry,
    );
  });

  it("reloads cached profile auth services when the profile auth file changes", () => {
    const userDir = tempUserDir();
    const state = makeState(userDir);
    const profileId = addProfile(state, "openai-codex", "Codex Work");

    const services = authProfileServicesForTab(state, "default");
    const reload = vi.spyOn(services.authStorage, "reload");
    const refresh = vi.spyOn(services.modelRegistry, "refresh");
    const authPath = authProfileAuthPath(userDir, profileId);
    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": { type: "api_key", key: "new" } }),
    );
    const future = new Date(Date.now() + 10_000);
    utimesSync(authPath, future, future);

    const refreshed = refreshAuthServicesForTab(state, "default");

    expect(refreshed).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(authProfileServicesForTab(state, "default")).toBe(services);
  });

  it("force-refreshes profile services even when the auth file mtime is unchanged", () => {
    const state = makeState();
    addProfile(state, "openai-codex", "Codex Work");
    const services = authProfileServicesForTab(state, "default");
    const reload = vi.spyOn(services.authStorage, "reload");
    const refresh = vi.spyOn(services.modelRegistry, "refresh");

    const refreshed = refreshAuthServicesForTab(state, "default", {
      forceRefresh: true,
    });

    expect(refreshed).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("refreshes cached default profile services before a new tab uses that provider", () => {
    const userDir = tempUserDir();
    const state = makeState(userDir);
    const profileId = addProfile(state, "openai-codex", "Codex Work");
    const services = authProfileServicesForTab(state, "existing-tab");
    const reload = vi.spyOn(services.authStorage, "reload");
    const refresh = vi.spyOn(services.modelRegistry, "refresh");
    const authPath = authProfileAuthPath(userDir, profileId);
    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": { type: "api_key", key: "new" } }),
    );
    const future = new Date(Date.now() + 10_000);
    utimesSync(authPath, future, future);

    const refreshed = refreshAuthServicesForTab(state, "new-tab", {
      modelId: "openai-codex/gpt-5.1-codex",
    });

    expect(state.tabAuthProfileIds.has("new-tab")).toBe(false);
    expect(refreshed).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("selects matching idle provider tabs for backend refresh after auth changes", () => {
    const state = makeState();
    state.tabs.set("active", fakeTab("openai-codex/gpt-5.4"));
    state.tabs.set("other-provider", fakeTab("anthropic/claude-opus-4-7"));
    state.tabs.set("busy", fakeTab("openai-codex/gpt-5.4", true));
    state.tabs.set("other-profile", fakeTab("openai-codex/gpt-5.4"));
    state.tabAuthProfileIds.set("other-profile", "different-profile");

    expect(
      authRefreshTabIds(state, {
        profileId: "codex-work",
        providerId: "openai-codex",
        targetTabId: "active",
      }),
    ).toEqual(["active"]);
  });

  it("emits auth profiles after API key save even when session refresh fails", async () => {
    const userDir = tempUserDir();
    const state = makeState(userDir);
    state.tabs.set("active", fakeTab("openai-codex/gpt-5.4"));
    const sent: Record<string, unknown>[] = [];
    const deps = {
      send: (message: Record<string, unknown>) => sent.push(message),
    } as DispatcherDeps;

    await handleAuthProfileMessage(state, deps, {
      type: "auth_profile_api_key_save",
      providerId: "openai-codex",
      key: "sk-test",
      label: "Codex Work",
      tabId: "active",
    });

    expect(loadAuthProfilesState(userDir).profiles).toHaveLength(1);
    expect(state.authProfiles.defaultByProvider["openai-codex"]).toBe(
      state.authProfiles.profiles[0]?.id,
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "auth_profile_api_key_save: refresh session:",
        ),
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "auth_profiles" }),
    );
  });

  it("auth_profile_use_for_tab records a worker tab without rebuilding the global session", async () => {
    const userDir = tempUserDir();
    const state = withReadyState(makeState(userDir));
    const profileId = addProfile(state, "openai-codex", "Codex Two");
    saveAuthProfilesState(userDir, state.authProfiles);
    const sent: Record<string, unknown>[] = [];
    const deps = {
      send: (m: Record<string, unknown>) => sent.push(m),
    } as DispatcherDeps;

    await handleAuthProfileMessage(state, deps, {
      type: "auth_profile_use_for_tab",
      tabId: "tab-worker",
      profileId,
    });

    // The mapping is recorded and surfaced, but the global bridge must NOT
    // spawn a session for the worker-owned tab (that blocks on a devshell
    // prepare it can't satisfy) and must NOT emit a model override (which would
    // silently reset the tab's model). The worker's apply owns the session.
    expect(state.tabAuthProfileIds.get("tab-worker")).toBe(profileId);
    expect(state.tabs.has("tab-worker")).toBe(false);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "auth_profile_changed",
        tabId: "tab-worker",
        profileId,
        model: "",
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "auth_profiles" }),
    );
  });

  it("auth_profile_apply refuses to switch a worker tab mid-prompt", async () => {
    const userDir = tempUserDir();
    const state = makeState(userDir);
    const profileId = addProfile(state, "openai-codex", "Codex Two");
    // handleApplyForTab reloads profiles from disk (the worker's in-memory
    // list may be stale), so the profile must be persisted.
    saveAuthProfilesState(userDir, state.authProfiles);
    const busy = fakeTab("openai-codex/gpt-5.5", true);
    state.tabs.set("tab-worker", busy);
    state.tabAuthProfileIds.set("tab-worker", "openai-codex-other");
    const sent: Record<string, unknown>[] = [];
    const deps = {
      send: (m: Record<string, unknown>) => sent.push(m),
    } as DispatcherDeps;

    await handleAuthProfileMessage(state, deps, {
      type: "auth_profile_apply",
      tabId: "tab-worker",
      profileId,
    });

    // Busy guard: assignment unchanged, a notice is emitted, no recreate.
    expect(state.tabAuthProfileIds.get("tab-worker")).toBe("openai-codex-other");
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "notice", tabId: "tab-worker" }),
    );
  });

  it("auth_profile_apply is a no-op for an unknown profile id", async () => {
    const state = makeState();
    const deps = { send: vi.fn() } as unknown as DispatcherDeps;

    await handleAuthProfileMessage(state, deps, {
      type: "auth_profile_apply",
      tabId: "tab-worker",
      profileId: "does-not-exist",
    });

    expect(state.tabAuthProfileIds.has("tab-worker")).toBe(false);
  });

  it("parses the email claim out of a JWT id_token", () => {
    const payload = { email: "codex-user@example.com", sub: "abc" };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const idToken = `header.${encoded}.signature`;

    expect(parseIdTokenEmail(idToken)).toBe("codex-user@example.com");
  });

  it("returns undefined for malformed id_tokens or missing email", () => {
    expect(parseIdTokenEmail("not-a-jwt")).toBeUndefined();
    const noEmail = Buffer.from(JSON.stringify({ sub: "abc" }), "utf8")
      .toString("base64url");
    expect(parseIdTokenEmail(`header.${noEmail}.sig`)).toBeUndefined();
    expect(parseIdTokenEmail("header.!!!notbase64!!!.sig")).toBeUndefined();
  });

  it("rejects deleting unknown or unsafe profile ids before removing files", async () => {
    const state = makeState();
    const deps = {
      send: vi.fn(),
    } as unknown as DispatcherDeps;

    await expect(
      handleAuthProfileMessage(state, deps, {
        type: "auth_profile_delete",
        profileId: "../escape",
      }),
    ).rejects.toThrow(/unknown profileId/);
  });
});
