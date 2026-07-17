import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import { registerOpenAIPreviewModels } from "../openai-preview-models";
import { authProfileAuthPath, isSafeProfileId } from "./store";
import { findProfile } from "./profile-state";
import type { AuthProfileProvider, AuthProfileServices } from "./types";

const globalAuthMtimes = new WeakMap<AethonAgentState, number | undefined>();

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
    registerOpenAIPreviewModels(state.modelRegistry);
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

export function servicesForProfile(
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
  registerOpenAIPreviewModels(modelRegistry);
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
  registerOpenAIPreviewModels(services.modelRegistry);
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function authProfileProviders(
  state: AethonAgentState,
): AuthProfileProvider[] {
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
