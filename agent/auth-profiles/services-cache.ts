import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AethonAgentState } from "../state";
import { logger } from "../logger";
import { authProfileAuthPath, isSafeProfileId } from "./store";
import { findProfile } from "./profile-state";
import type { AuthProfileProvider, AuthProfileServices } from "./types";

const globalAuthMtimes = new WeakMap<AethonAgentState, number | undefined>();
const servicesLog = logger.scope("auth-services");

/** Build a pi model/auth pair for `authPath` (pi's default `auth.json` when
 *  omitted). `ModelRuntime.create` is async — it restores cached catalogs and
 *  computes availability — so every profile is warmed once at boot
 *  ({@link warmAuthProfileServices}) and on profile creation
 *  ({@link ensureProfileServices}); the synchronous lookups below only ever
 *  hit that cache. */
export async function createAuthServices(
  authPath?: string,
): Promise<AuthProfileServices> {
  // Profile runtimes keep their dynamic-catalog cache next to their
  // auth.json: provider catalogs (Copilot, pi.dev overlays) are resolved per
  // credential, so sharing pi's global models-store across accounts would
  // let one profile's catalog leak into another.
  const modelRuntime = await ModelRuntime.create(
    authPath
      ? {
          authPath,
          modelsStorePath: join(dirname(authPath), "models-store.json"),
        }
      : {},
  );
  const modelRegistry = new ModelRegistry(modelRuntime);
  return {
    modelRuntime,
    modelRegistry,
    authPath,
    authMtimeMs: authPath ? fileMtimeMs(authPath) : undefined,
  };
}

/** Pre-build services for every persisted profile so the synchronous
 *  `servicesForProfile` path never has to construct a runtime. */
export async function warmAuthProfileServices(
  state: AethonAgentState,
): Promise<void> {
  await Promise.all(
    state.authProfiles.profiles.map(async (profile) => {
      try {
        await ensureProfileServices(state, profile.id);
      } catch (err) {
        servicesLog.warn(
          `profile ${profile.id}: services init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}

/** Async counterpart of {@link servicesForProfile}: creates the runtime when
 *  the profile has not been warmed yet. Call this from every path that adds a
 *  profile before handing the id to synchronous code. */
export async function ensureProfileServices(
  state: AethonAgentState,
  profileId: string,
): Promise<AuthProfileServices> {
  if (!isSafeProfileId(profileId)) {
    throw new Error(`Invalid auth profile id: ${profileId}`);
  }
  const cached = state.authProfileServices.get(profileId);
  if (cached) return cached;
  const authPath = authProfileAuthPath(state.userDir, profileId);
  mkdirSync(dirname(authPath), { recursive: true });
  const services = await createAuthServices(authPath);
  // A concurrent warm may have raced us; keep the first one so every caller
  // shares a single runtime per profile.
  const existing = state.authProfileServices.get(profileId);
  if (existing) return existing;
  state.authProfileServices.set(profileId, services);
  return services;
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
    return globalServices(state);
  }
  const profile = state.authProfiles.profiles.find((p) => p.id === profileId);
  if (!profile) {
    state.tabAuthProfileIds.delete(tabId);
    return globalServices(state);
  }
  state.tabAuthProfileIds.set(tabId, profile.id);
  return servicesForProfile(state, profile.id);
}

/** Async pre-flight for {@link authProfileServicesForTab}: resolves the tab's
 *  profile the same way and warms its runtime. Needed because a profile can
 *  be persisted by another bridge process (the global bridge runs the login
 *  flow; a per-tab worker only reloads the list from disk), so this process
 *  may never have warmed it at boot. */
export async function ensureTabAuthProfileServices(
  state: AethonAgentState,
  tabId: string,
  initialModel?: Model<Api>,
): Promise<void> {
  const profileId =
    state.tabAuthProfileIds.get(tabId) ??
    defaultProfileIdForTab(state, initialModel);
  if (profileId && findProfile(state, profileId)) {
    await ensureProfileServices(state, profileId);
  }
}

function globalServices(state: AethonAgentState): AuthProfileServices {
  return {
    modelRuntime: state.modelRuntime,
    modelRegistry: state.modelRegistry,
  };
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
  if (!state.modelRuntime || !state.modelRegistry) return false;

  const authPath = join(getAgentDir(), "auth.json");
  const authMtimeMs = fileMtimeMs(authPath);
  const previous = globalAuthMtimes.get(state);
  const refreshed = options.forceRefresh === true || previous !== authMtimeMs;
  if (refreshed) {
    refreshServicePair(globalServices(state));
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
 * modelRuntime AND modelRegistry as a pair — the model's base URL / key live on
 * that profile's modelRuntime, so they must be resolved together. Falls back to
 * the global services when the provider has no configured profile.
 */
export function servicesForProvider(
  state: AethonAgentState,
  provider: string,
): AuthProfileServices {
  const profileId = state.authProfiles.defaultByProvider[provider];
  return profileId && findProfile(state, profileId)
    ? servicesForProfile(state, profileId)
    : globalServices(state);
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
  throw new Error(
    `auth profile services not initialized for ${profileId} — await ensureProfileServices() first`,
  );
}

/** Kick a catalog + credential refresh. pi's file-backed credential store
 *  already re-reads `auth.json` when its revision changes, so this mainly
 *  recomputes the availability snapshot. Refresh is async in pi >= 0.80.8;
 *  callers keep the synchronous contract and the registry converges in the
 *  background. */
function refreshServicePair(services: AuthProfileServices): void {
  void services.modelRegistry.refresh().catch((err: unknown) => {
    servicesLog.warn(
      `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
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
  if (!state.modelRuntime || !state.modelRegistry) return [];
  const oauthIds = new Map(
    state.modelRuntime
      .getProviders()
      .filter((p) => p.auth.oauth !== undefined)
      .map((p) => [p.id, p.name] as const),
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
