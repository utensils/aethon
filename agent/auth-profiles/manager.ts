import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { clearPendingContextUsageEmit } from "../context-usage";
import { ensureTab } from "../tab-lifecycle";
import {
  authProfileAuthPath,
  createProfileMeta,
  deleteProfileFiles,
  isSafeProfileId,
  loadAuthProfilesState,
  saveAuthProfilesState,
  type AuthProfileMeta,
  type AuthProfilesState,
} from "./store";

export interface AuthProfileServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  authPath?: string;
  authMtimeMs?: number;
}

export interface AuthProfileProvider {
  id: string;
  label: string;
  kind: "oauth" | "api_key";
  configured: boolean;
  modelCount: number;
}

export interface AuthProfilesSnapshot {
  profiles: AuthProfileMeta[];
  defaultByProvider: Record<string, string>;
  providers: AuthProfileProvider[];
  activeByTab: Record<string, string>;
}

interface PendingOAuth {
  profileId: string;
  providerId: string;
  targetTabId?: string;
  controller: AbortController;
  isReauth: boolean;
  resolvePrompt?: (value: string) => void;
}

const pendingOAuth = new Map<string, PendingOAuth>();
const globalAuthMtimes = new WeakMap<AethonAgentState, number | undefined>();

export function loadAuthProfiles(userDir: string): AuthProfilesState {
  return loadAuthProfilesState(userDir);
}

export function saveAuthProfiles(state: AethonAgentState): void {
  saveAuthProfilesState(state.userDir, state.authProfiles);
}

export function authProfilesSnapshot(
  state: AethonAgentState,
): AuthProfilesSnapshot {
  return {
    profiles: state.authProfiles.profiles,
    defaultByProvider: state.authProfiles.defaultByProvider,
    providers: authProfileProviders(state),
    activeByTab: Object.fromEntries(state.tabAuthProfileIds),
  };
}

export function authProfileServicesForTab(
  state: AethonAgentState,
  tabId: string,
  initialModel?: Model<Api>,
): AuthProfileServices {
  const profileId =
    state.tabAuthProfileIds.get(tabId) ??
    defaultProfileIdForTab(state, initialModel);
  if (!profileId) {
    return {
      authStorage: state.authStorage,
      modelRegistry: state.modelRegistry,
    };
  }
  const profile = state.authProfiles.profiles.find((p) => p.id === profileId);
  if (!profile) {
    state.tabAuthProfileIds.delete(tabId);
    return {
      authStorage: state.authStorage,
      modelRegistry: state.modelRegistry,
    };
  }
  state.tabAuthProfileIds.set(tabId, profile.id);
  return servicesForProfile(state, profile.id);
}

export function defaultProfileIdForTab(
  state: AethonAgentState,
  initialModel?: Model<Api>,
): string | undefined {
  const candidates = [
    initialModel?.provider,
    state.settingsManager?.getDefaultProvider(),
    providerFromModelId(state.settingsManager?.getDefaultModel()),
  ];
  for (const providerId of candidates) {
    if (!providerId) continue;
    const profileId = state.authProfiles.defaultByProvider[providerId];
    if (profileId) return profileId;
  }
  const defaults = Object.values(state.authProfiles.defaultByProvider);
  return defaults.length === 1 ? defaults[0] : undefined;
}

function providerFromModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return undefined;
  return modelId.slice(0, slash);
}

export function modelRegistryForModelId(
  state: AethonAgentState,
  tabId: string,
  modelId: string,
): ModelRegistry {
  const [provider] = modelId.split("/");
  const profileId =
    state.tabAuthProfileIds.get(tabId) ??
    state.authProfiles.defaultByProvider[provider];
  return profileId && findProfile(state, profileId)
    ? servicesForProfile(state, profileId).modelRegistry
    : state.modelRegistry;
}

export function refreshAuthServicesForTab(
  state: AethonAgentState,
  tabId: string,
  options: {
    forceRefresh?: boolean;
    initialModel?: Model<Api>;
    modelId?: string;
  } = {},
): boolean {
  const profileId =
    state.tabAuthProfileIds.get(tabId) ??
    defaultProfileIdForTab(
      state,
      options.initialModel ?? modelStubFromId(options.modelId),
    );
  if (profileId && findProfile(state, profileId)) {
    return servicesForProfileWithStatus(state, profileId, {
      forceRefresh: options.forceRefresh,
    }).refreshed;
  }
  return refreshGlobalAuthServicesIfChanged(state, options);
}

function modelStubFromId(modelId: string | undefined): Model<Api> | undefined {
  if (!modelId) return undefined;
  const [provider] = modelId.split("/");
  if (!provider) return undefined;
  return { provider, id: "" } as Model<Api>;
}

export function refreshGlobalAuthServicesIfChanged(
  state: AethonAgentState,
  options: { forceRefresh?: boolean } = {},
): boolean {
  if (!state.authStorage || !state.modelRegistry) return false;

  const authPath = join(getAgentDir(), "auth.json");
  const authMtimeMs = fileMtimeMs(authPath);
  const previous = globalAuthMtimes.get(state);
  const refreshed = options.forceRefresh === true || previous !== authMtimeMs;
  if (refreshed) {
    state.authStorage.reload();
    state.modelRegistry.refresh();
    globalAuthMtimes.set(state, authMtimeMs);
  }
  return refreshed;
}

export function refreshTabSessionModelFromAuthServices(
  state: AethonAgentState,
  tabId: string,
): void {
  const tab = state.tabs.get(tabId);
  const current = tab?.session.model;
  if (!tab || !current) return;
  const refreshed = modelRegistryForModelId(
    state,
    tabId,
    `${current.provider}/${current.id}`,
  ).find(current.provider, current.id);
  if (!refreshed) return;
  const mutableSession = tab.session as {
    state?: { model?: Model<Api> };
  };
  if (mutableSession.state) mutableSession.state.model = refreshed;
}

/**
 * Resolve the auth + model services for a *provider's* default profile,
 * independent of any tab. Unlike {@link modelRegistryForModelId} this ignores
 * the calling tab's profile, so a subagent on a different provider (e.g. an
 * Ollama subagent delegated to by an OpenAI main agent) gets the matching
 * authStorage AND modelRegistry as a pair — the model's base URL / key live on
 * that profile's authStorage, so they must be resolved together. Falls back to
 * the global services when the provider has no configured profile.
 */
export function servicesForProvider(
  state: AethonAgentState,
  provider: string,
): AuthProfileServices {
  const profileId = state.authProfiles.defaultByProvider[provider];
  return profileId && findProfile(state, profileId)
    ? servicesForProfile(state, profileId)
    : { authStorage: state.authStorage, modelRegistry: state.modelRegistry };
}

export async function handleAuthProfileMessage(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<boolean> {
  switch (msg.type) {
    case "auth_profiles_list":
      emitAuthProfiles(state, deps);
      return true;
    case "auth_profile_api_key_save":
      await handleApiKeySave(state, deps, msg);
      return true;
    case "auth_profile_login_start":
      handleOAuthStart(state, deps, msg);
      return true;
    case "auth_profile_oauth_input":
      handleOAuthInput(msg);
      return true;
    case "auth_profile_oauth_cancel":
      handleOAuthCancel(state, deps, msg);
      return true;
    case "auth_profile_use_for_tab":
      await handleUseForTab(state, deps, msg);
      return true;
    case "auth_profile_set_default":
      handleSetDefault(state, deps, msg);
      return true;
    case "auth_profile_rename":
      handleRename(state, deps, msg);
      return true;
    case "auth_profile_delete":
      handleDelete(state, deps, msg);
      return true;
    case "auth_profile_fetch_usage":
      void handleFetchUsage(state, deps, msg);
      return true;
    default:
      return false;
  }
}

export function emitAuthProfiles(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
): void {
  deps.send({
    type: "auth_profiles",
    authProfiles: authProfilesSnapshot(state),
  });
}

function servicesForProfile(
  state: AethonAgentState,
  profileId: string,
  options: { forceRefresh?: boolean } = {},
): AuthProfileServices {
  return servicesForProfileWithStatus(state, profileId, options).services;
}

function servicesForProfileWithStatus(
  state: AethonAgentState,
  profileId: string,
  options: { forceRefresh?: boolean } = {},
): { services: AuthProfileServices; refreshed: boolean } {
  if (!isSafeProfileId(profileId)) {
    throw new Error(`Invalid auth profile id: ${profileId}`);
  }
  const authPath = authProfileAuthPath(state.userDir, profileId);
  const cached = state.authProfileServices.get(profileId);
  if (cached) {
    const authMtimeMs = fileMtimeMs(authPath);
    const changed = cached.authMtimeMs !== authMtimeMs;
    const refreshed = options.forceRefresh === true || changed;
    if (refreshed) {
      refreshServicePair(cached);
      cached.authPath = authPath;
      cached.authMtimeMs = authMtimeMs;
    }
    return { services: cached, refreshed };
  }
  mkdirSync(dirname(authPath), { recursive: true });
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage);
  const services = {
    authStorage,
    modelRegistry,
    authPath,
    authMtimeMs: fileMtimeMs(authPath),
  };
  state.authProfileServices.set(profileId, services);
  return { services, refreshed: false };
}

function refreshServicePair(services: AuthProfileServices): void {
  services.authStorage.reload();
  services.modelRegistry.refresh();
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function authProfileProviders(state: AethonAgentState): AuthProfileProvider[] {
  if (!state.authStorage || !state.modelRegistry) return [];
  const oauthIds = new Map(
    state.authStorage.getOAuthProviders().map((p) => [p.id, p.name]),
  );
  const modelCounts = new Map<string, number>();
  for (const model of state.modelRegistry.getAll()) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }
  const ids = new Set([...oauthIds.keys(), ...modelCounts.keys()]);
  return [...ids]
    .map((id) => ({
      id,
      label:
        state.modelRegistry.getProviderDisplayName(id) ||
        oauthIds.get(id) ||
        id,
      kind: oauthIds.has(id) ? ("oauth" as const) : ("api_key" as const),
      configured: state.modelRegistry.getProviderAuthStatus(id).configured,
      modelCount: modelCounts.get(id) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function handleApiKeySave(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const providerId = stringField(msg.providerId);
  const key = stringField(msg.key);
  if (!providerId || !key)
    throw new Error("auth_profile_api_key_save: providerId and key required");
  const targetTabId = normalizedTabId(msg.tabId);
  const requestedProfileId = stringField(msg.profileId);
  const existing = requestedProfileId
    ? findProfile(state, requestedProfileId)
    : undefined;
  if (requestedProfileId && !existing) {
    throw new Error("auth_profile_api_key_save: unknown profileId");
  }
  if (existing && existing.providerId !== providerId) {
    throw new Error("auth_profile_api_key_save: providerId mismatch");
  }
  if (existing && existing.kind !== "api_key") {
    throw new Error("auth_profile_api_key_save: profile is not api_key");
  }
  const meta =
    existing ??
    createProfileMeta(state.authProfiles, {
      providerId,
      label: stringField(msg.label) || providerId,
      kind: "api_key",
    });
  const services = servicesForProfile(state, meta.id, { forceRefresh: true });
  services.authStorage.set(providerId, { type: "api_key", key });
  const now = Date.now();
  state.authProfiles = existing
    ? {
        ...state.authProfiles,
        profiles: state.authProfiles.profiles.map((p) =>
          p.id === meta.id ? { ...p, updatedAt: now, lastUsedAt: now } : p,
        ),
      }
    : {
        ...state.authProfiles,
        profiles: [...state.authProfiles.profiles, meta],
      };
  if (!state.authProfiles.defaultByProvider[providerId]) {
    state.authProfiles.defaultByProvider[providerId] = meta.id;
  }
  saveAuthProfiles(state);
  servicesForProfile(state, meta.id, { forceRefresh: true });
  try {
    await refreshTabsAfterAuthChange(state, deps, {
      profileId: meta.id,
      providerId,
      targetTabId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      message: `auth_profile_api_key_save: refresh session: ${message}`,
    });
  }
  emitAuthProfiles(state, deps);
  try {
    await emitGlobalReady(state, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      message: `auth_profile_api_key_save: emit ready: ${message}`,
    });
  }
}

function handleOAuthStart(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const providerId = stringField(msg.providerId);
  if (!providerId)
    throw new Error("auth_profile_login_start: providerId required");
  const requestedProfileId = stringField(msg.profileId);
  const existing = requestedProfileId
    ? findProfile(state, requestedProfileId)
    : undefined;
  if (requestedProfileId && !existing) {
    throw new Error("auth_profile_login_start: unknown profileId");
  }
  if (existing && existing.providerId !== providerId) {
    throw new Error("auth_profile_login_start: providerId mismatch");
  }
  if (existing && existing.kind !== "oauth") {
    throw new Error("auth_profile_login_start: profile is not oauth");
  }
  const isReauth = Boolean(existing);
  const targetTabId = normalizedTabId(msg.tabId);
  const meta =
    existing ??
    createProfileMeta(state.authProfiles, {
      providerId,
      label: stringField(msg.label) || providerId,
      kind: "oauth",
    });
  if (!existing) {
    state.authProfiles = {
      ...state.authProfiles,
      profiles: [...state.authProfiles.profiles, meta],
    };
    saveAuthProfiles(state);
  }
  // Abort any lingering OAuth flow for this provider — pi-ai's callback
  // server binds to a hardcoded port per provider, so a stale server from
  // a previous login blocks the new flow's state from registering.
  for (const [oldId, oldPending] of pendingOAuth) {
    if (oldPending.providerId === providerId) {
      oldPending.controller.abort();
      pendingOAuth.delete(oldId);
    }
  }

  const services = servicesForProfile(state, meta.id, { forceRefresh: true });
  const challengeId = randomUUID();
  const pending: PendingOAuth = {
    profileId: meta.id,
    providerId,
    targetTabId,
    controller: new AbortController(),
    isReauth,
  };
  pendingOAuth.set(challengeId, pending);
  deps.send({
    type: "auth_profile_login_event",
    event: { type: "started", challengeId, profileId: meta.id, providerId },
  });
  void services.authStorage
    .login(providerId, {
      signal: pending.controller.signal,
      onAuth: ({ url, instructions }) => {
        deps.send({
          type: "auth_profile_login_event",
          event: {
            type: "auth",
            challengeId,
            profileId: meta.id,
            providerId,
            url,
            instructions,
          },
        });
      },
      onProgress: (message) => {
        deps.send({
          type: "auth_profile_login_event",
          event: {
            type: "progress",
            challengeId,
            profileId: meta.id,
            providerId,
            message,
          },
        });
      },
      onPrompt: ({ message, placeholder, allowEmpty }) =>
        new Promise<string>((resolve) => {
          pending.resolvePrompt = resolve;
          deps.send({
            type: "auth_profile_login_event",
            event: {
              type: "prompt",
              challengeId,
              profileId: meta.id,
              providerId,
              message,
              placeholder,
              allowEmpty,
            },
          });
        }),
      onManualCodeInput: () =>
        new Promise<string>((resolve) => {
          pending.resolvePrompt = resolve;
          deps.send({
            type: "auth_profile_login_event",
            event: {
              type: "prompt",
              challengeId,
              profileId: meta.id,
              providerId,
              message: "Paste the authorization code or callback URL.",
              allowEmpty: false,
            },
          });
        }),
    })
    .then(async () => {
      pendingOAuth.delete(challengeId);
      const now = Date.now();
      state.authProfiles = {
        ...state.authProfiles,
        profiles: state.authProfiles.profiles.map((p) =>
          p.id === meta.id ? { ...p, updatedAt: now, lastUsedAt: now } : p,
        ),
      };
      if (!state.authProfiles.defaultByProvider[providerId]) {
        state.authProfiles.defaultByProvider[providerId] = meta.id;
      }
      saveAuthProfiles(state);
      servicesForProfile(state, meta.id, { forceRefresh: true });
      try {
        await refreshTabsAfterAuthChange(state, deps, {
          profileId: meta.id,
          providerId,
          targetTabId: pending.targetTabId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "error",
          message: `auth_profile_login_start: refresh session: ${message}`,
        });
      }
      deps.send({
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId,
          profileId: meta.id,
          providerId,
          ok: true,
        },
      });
      emitAuthProfiles(state, deps);
      try {
        await emitGlobalReady(state, deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "error",
          message: `auth_profile_login_start: emit ready: ${message}`,
        });
      }
    })
    .catch((err: unknown) => {
      pendingOAuth.delete(challengeId);
      if (!isReauth) removeProfile(state, meta.id);
      saveAuthProfiles(state);
      const message = err instanceof Error ? err.message : String(err);
      deps.send({
        type: "auth_profile_login_event",
        event: {
          type: "complete",
          challengeId,
          profileId: meta.id,
          providerId,
          ok: false,
          error: message,
        },
      });
      emitAuthProfiles(state, deps);
    });
}

function handleOAuthInput(msg: InboundMessage): void {
  const challengeId = stringField(msg.challengeId);
  const pending = challengeId ? pendingOAuth.get(challengeId) : undefined;
  if (!pending?.resolvePrompt) return;
  const resolve = pending.resolvePrompt;
  pending.resolvePrompt = undefined;
  resolve(stringField(msg.value));
}

function handleOAuthCancel(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const challengeId = stringField(msg.challengeId);
  const pending = challengeId ? pendingOAuth.get(challengeId) : undefined;
  if (!pending) return;
  pending.controller.abort();
  pendingOAuth.delete(challengeId);
  if (!pending.isReauth) removeProfile(state, pending.profileId);
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}

async function refreshTabsAfterAuthChange(
  state: AethonAgentState,
  deps: DispatcherDeps,
  options: {
    profileId: string;
    providerId: string;
    targetTabId?: string;
  },
): Promise<void> {
  for (const tabId of authRefreshTabIds(state, options)) {
    state.tabAuthProfileIds.set(tabId, options.profileId);
    await recreateTabSession(state, deps, tabId, options.profileId);
  }
}

export function authRefreshTabIds(
  state: AethonAgentState,
  options: {
    profileId: string;
    providerId: string;
    targetTabId?: string;
  },
): string[] {
  const tabIds = new Set<string>();
  for (const [tabId, activeProfileId] of state.tabAuthProfileIds) {
    if (activeProfileId === options.profileId) tabIds.add(tabId);
  }
  if (options.targetTabId) tabIds.add(options.targetTabId);
  for (const [tabId, tab] of state.tabs) {
    if (
      !state.tabAuthProfileIds.has(tabId) &&
      tab.session.model?.provider === options.providerId
    ) {
      tabIds.add(tabId);
    }
  }

  const out: string[] = [];
  for (const tabId of tabIds) {
    const existing = state.tabs.get(tabId);
    if (!existing || existing.promptInFlight) continue;
    const activeProfileId = state.tabAuthProfileIds.get(tabId);
    if (activeProfileId && activeProfileId !== options.profileId) continue;
    const modelProvider = existing.session.model?.provider;
    if (modelProvider && modelProvider !== options.providerId) continue;
    out.push(tabId);
  }
  return out;
}

async function recreateTabSession(
  state: AethonAgentState,
  deps: DispatcherDeps,
  tabId: string,
  profileId: string,
): Promise<void> {
  const existing = state.tabs.get(tabId);
  const previousModel = existing?.session.model;
  const cwd = state.tabProjectCwds.get(tabId);
  if (existing) clearPendingContextUsageEmit(existing);
  state.tabs.delete(tabId);
  state.tabAuthProfileIds.set(tabId, profileId);
  const services = servicesForProfile(state, profileId, { forceRefresh: true });
  const nextModel =
    previousModel &&
    services.modelRegistry.find(previousModel.provider, previousModel.id);
  await ensureTab(state, deps, tabId, {
    cwdOverride: cwd,
    initialModel: nextModel || previousModel,
  });
}

async function handleUseForTab(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = stringField(msg.tabId) || "default";
  const profileId = stringField(msg.profileId);
  const profile = profileId
    ? state.authProfiles.profiles.find((p) => p.id === profileId)
    : undefined;
  if (!profile) throw new Error("auth_profile_use_for_tab: unknown profileId");
  const existing = state.tabs.get(tabId);
  if (existing?.promptInFlight) {
    deps.send({
      type: "notice",
      tabId,
      message: "agent busy — stop the current prompt before switching accounts",
    });
    return;
  }
  const previousModel = existing?.session.model;
  const cwd = state.tabProjectCwds.get(tabId);
  if (existing) clearPendingContextUsageEmit(existing);
  state.tabs.delete(tabId);
  state.tabAuthProfileIds.set(tabId, profile.id);
  const services = servicesForProfile(state, profile.id, { forceRefresh: true });
  const nextModel =
    previousModel &&
    services.modelRegistry.find(previousModel.provider, previousModel.id);
  const rec = await ensureTab(state, deps, tabId, {
    cwdOverride: cwd,
    initialModel: nextModel || previousModel,
  });
  markProfileUsed(state, profile.id);
  deps.send({
    type: "auth_profile_changed",
    tabId,
    profileId: profile.id,
    model: rec.session.model
      ? `${rec.session.model.provider}/${rec.session.model.id}`
      : "",
  });
  emitAuthProfiles(state, deps);
  await emitGlobalReady(state, deps);
}

function handleSetDefault(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const profileId = stringField(msg.profileId);
  const profile = state.authProfiles.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("auth_profile_set_default: unknown profileId");
  state.authProfiles.defaultByProvider[profile.providerId] = profile.id;
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}

function handleRename(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const profileId = stringField(msg.profileId);
  const label = stringField(msg.label).trim();
  if (!label) throw new Error("auth_profile_rename: label required");
  const now = Date.now();
  state.authProfiles = {
    ...state.authProfiles,
    profiles: state.authProfiles.profiles.map((p) =>
      p.id === profileId ? { ...p, label, updatedAt: now } : p,
    ),
  };
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}

function handleDelete(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const profileId = stringField(msg.profileId);
  const profile = findProfile(state, profileId);
  if (!profile) throw new Error("auth_profile_delete: unknown profileId");
  for (const [tabId, activeProfileId] of state.tabAuthProfileIds) {
    if (activeProfileId !== profileId) continue;
    const tab = state.tabs.get(tabId);
    if (tab?.promptInFlight) {
      throw new Error(
        "Cannot delete an account while one of its sessions is running.",
      );
    }
  }
  removeProfile(state, profileId);
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}

const CODEX_PROVIDER_ID = "openai-codex";

export function parseIdTokenEmail(idToken: string): string | undefined {
  const segments = idToken.split(".");
  if (segments.length < 2) return undefined;
  const payload = segments[1];
  if (!payload) return undefined;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

async function handleFetchUsage(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
  msg: InboundMessage,
): Promise<void> {
  const profileId = stringField(msg.profileId);
  logger.scope("auth-usage").info(`fetch usage for ${profileId}`);
  try {
    const profile = findProfile(state, profileId);
    if (!profile) throw new Error("unknown profileId");

    if (profile.providerId === CODEX_PROVIDER_ID) {
      const { fetchCodexProfileUsage } = await import("./codex-usage");
      const authPath = authProfileAuthPath(state.userDir, profile.id);
      const usage = await fetchCodexProfileUsage(authPath, profile.providerId);
      logger
        .scope("auth-usage")
        .info(
          `${profileId} → email=${usage.email ?? "none"} plan=${usage.planType ?? "none"} primary=${usage.primary?.usedPercent ?? "none"}`,
        );
      deps.send({
        type: "auth_profile_usage",
        profileId: profile.id,
        ...usage,
      });
    } else {
      const authPath = authProfileAuthPath(state.userDir, profile.id);
      let email: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<
          string,
          unknown
        >;
        const entry = parsed[profile.providerId];
        if (entry && typeof entry === "object") {
          const creds = entry as Record<string, unknown>;
          const idToken =
            typeof creds.id_token === "string"
              ? creds.id_token
              : typeof creds.idToken === "string"
                ? creds.idToken
                : undefined;
          if (idToken) email = parseIdTokenEmail(idToken);
        }
      } catch {
        /* no credentials to read email from */
      }
      deps.send({
        type: "auth_profile_usage",
        profileId: profile.id,
        ...(email ? { email } : {}),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "auth_profile_usage",
      profileId,
      error: message,
    });
  }
}

function removeProfile(state: AethonAgentState, profileId: string): void {
  const profile = findProfile(state, profileId);
  if (!profile) return;
  state.authProfiles = {
    ...state.authProfiles,
    profiles: state.authProfiles.profiles.filter((p) => p.id !== profileId),
    defaultByProvider: Object.fromEntries(
      Object.entries(state.authProfiles.defaultByProvider).filter(
        ([, id]) => id !== profileId,
      ),
    ),
  };
  for (const [tabId, id] of state.tabAuthProfileIds) {
    if (id === profileId) state.tabAuthProfileIds.delete(tabId);
  }
  state.authProfileServices.delete(profileId);
  deleteProfileFiles(state.userDir, profileId);
}

function findProfile(
  state: AethonAgentState,
  profileId: string,
): AuthProfileMeta | undefined {
  if (!profileId || !isSafeProfileId(profileId)) return undefined;
  return state.authProfiles.profiles.find((p) => p.id === profileId);
}

function markProfileUsed(state: AethonAgentState, profileId: string): void {
  const now = Date.now();
  state.authProfiles = {
    ...state.authProfiles,
    profiles: state.authProfiles.profiles.map((p) =>
      p.id === profileId ? { ...p, lastUsedAt: now, updatedAt: now } : p,
    ),
  };
  saveAuthProfiles(state);
}

function normalizedTabId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
