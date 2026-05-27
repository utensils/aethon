import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { ensureTab } from "../tab-lifecycle";
import {
  authProfileAuthPath,
  createProfileMeta,
  deleteProfileFiles,
  loadAuthProfilesState,
  saveAuthProfilesState,
  type AuthProfileMeta,
  type AuthProfilesState,
} from "./store";

export interface AuthProfileServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
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
  controller: AbortController;
  resolvePrompt?: (value: string) => void;
}

const pendingOAuth = new Map<string, PendingOAuth>();

export function loadAuthProfiles(userDir: string): AuthProfilesState {
  return loadAuthProfilesState(userDir);
}

export function saveAuthProfiles(state: AethonAgentState): void {
  saveAuthProfilesState(state.userDir, state.authProfiles);
}

export function authProfilesSnapshot(state: AethonAgentState): AuthProfilesSnapshot {
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
  return profileId
    ? servicesForProfile(state, profileId).modelRegistry
    : state.modelRegistry;
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
      handleApiKeySave(state, deps, msg);
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
    default:
      return false;
  }
}

export function emitAuthProfiles(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
): void {
  deps.send({ type: "auth_profiles", authProfiles: authProfilesSnapshot(state) });
}

function servicesForProfile(
  state: AethonAgentState,
  profileId: string,
): AuthProfileServices {
  const cached = state.authProfileServices.get(profileId);
  if (cached) return cached;
  const authPath = authProfileAuthPath(state.userDir, profileId);
  mkdirSync(dirname(authPath), { recursive: true });
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage);
  const services = { authStorage, modelRegistry };
  state.authProfileServices.set(profileId, services);
  return services;
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
      label: state.modelRegistry.getProviderDisplayName(id) || oauthIds.get(id) || id,
      kind: oauthIds.has(id) ? ("oauth" as const) : ("api_key" as const),
      configured: state.modelRegistry.getProviderAuthStatus(id).configured,
      modelCount: modelCounts.get(id) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function handleApiKeySave(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const providerId = stringField(msg.providerId);
  const key = stringField(msg.key);
  if (!providerId || !key) throw new Error("auth_profile_api_key_save: providerId and key required");
  const meta = createProfileMeta(state.authProfiles, {
    providerId,
    label: stringField(msg.label) || providerId,
    kind: "api_key",
  });
  const services = servicesForProfile(state, meta.id);
  services.authStorage.set(providerId, { type: "api_key", key });
  state.authProfiles = {
    ...state.authProfiles,
    profiles: [...state.authProfiles.profiles, meta],
  };
  if (!state.authProfiles.defaultByProvider[providerId]) {
    state.authProfiles.defaultByProvider[providerId] = meta.id;
  }
  saveAuthProfiles(state);
  state.authProfileServices.delete(meta.id);
  emitAuthProfiles(state, deps);
}

function handleOAuthStart(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const providerId = stringField(msg.providerId);
  if (!providerId) throw new Error("auth_profile_login_start: providerId required");
  const meta = createProfileMeta(state.authProfiles, {
    providerId,
    label: stringField(msg.label) || providerId,
    kind: "oauth",
  });
  state.authProfiles = {
    ...state.authProfiles,
    profiles: [...state.authProfiles.profiles, meta],
  };
  saveAuthProfiles(state);
  const services = servicesForProfile(state, meta.id);
  const challengeId = randomUUID();
  const pending: PendingOAuth = {
    profileId: meta.id,
    providerId,
    controller: new AbortController(),
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
          event: { type: "auth", challengeId, profileId: meta.id, providerId, url, instructions },
        });
      },
      onProgress: (message) => {
        deps.send({
          type: "auth_profile_login_event",
          event: { type: "progress", challengeId, profileId: meta.id, providerId, message },
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
    .then(() => {
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
      state.authProfileServices.delete(meta.id);
      deps.send({
        type: "auth_profile_login_event",
        event: { type: "complete", challengeId, profileId: meta.id, providerId, ok: true },
      });
      emitAuthProfiles(state, deps);
    })
    .catch((err: unknown) => {
      pendingOAuth.delete(challengeId);
      removeProfile(state, meta.id);
      saveAuthProfiles(state);
      const message = err instanceof Error ? err.message : String(err);
      deps.send({
        type: "auth_profile_login_event",
        event: { type: "complete", challengeId, profileId: meta.id, providerId, ok: false, error: message },
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
  removeProfile(state, pending.profileId);
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
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
  state.tabs.delete(tabId);
  state.tabAuthProfileIds.set(tabId, profile.id);
  const services = servicesForProfile(state, profile.id);
  const nextModel =
    previousModel && services.modelRegistry.find(previousModel.provider, previousModel.id);
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
  emitGlobalReady(state, deps);
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
  if (!profileId) throw new Error("auth_profile_delete: profileId required");
  for (const [tabId, activeProfileId] of state.tabAuthProfileIds) {
    if (activeProfileId !== profileId) continue;
    const tab = state.tabs.get(tabId);
    if (tab?.promptInFlight) {
      throw new Error("Cannot delete an account while one of its sessions is running.");
    }
  }
  removeProfile(state, profileId);
  saveAuthProfiles(state);
  emitAuthProfiles(state, deps);
}

function removeProfile(state: AethonAgentState, profileId: string): void {
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

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
