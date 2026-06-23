import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { clearPendingContextUsageEmit } from "../context-usage";
import { ensureTab } from "../tab-lifecycle";
import { loadAuthProfilesState } from "./store";
import { servicesForProfile } from "./services-cache";
import type { AuthProfileServices } from "./types";
import { markProfileUsed, normalizedTabId, stringField } from "./profile-state";
import { emitAuthProfiles } from "./snapshot";

export async function refreshTabsAfterAuthChange(
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

export async function handleUseForTab(
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
  state.tabAuthProfileIds.set(tabId, profile.id);
  markProfileUsed(state, profile.id);

  // The global bridge owns ONLY the default tab's session. Every non-default
  // tab runs its prompts in a per-tab worker bridge that rebuilds its own
  // session against the new account via `auth_profile_apply` (which this same
  // switch relays tab-scoped). Recreating the session here for a worker tab
  // would (a) spawn a spurious duplicate session on the global bridge, (b)
  // block the global message loop on an `ensureDevshellPrepared` for a cwd the
  // global bridge doesn't own — frequently timing out — which makes the whole
  // account switch appear to hang, and (c) emit the duplicate session's model
  // back as `auth_profile_changed.model`, silently resetting the tab's model.
  // So only rebuild the session for the default tab; for worker tabs just
  // record the mapping and let the worker's apply handle the session.
  let changedModel = "";
  if (tabId === "default") {
    const previousModel = existing?.session.model;
    const cwd = state.tabProjectCwds.get(tabId);
    if (existing) clearPendingContextUsageEmit(existing);
    state.tabs.delete(tabId);
    const services = servicesForProfile(state, profile.id, {
      forceRefresh: true,
    });
    const nextModel =
      previousModel &&
      services.modelRegistry.find(previousModel.provider, previousModel.id);
    const rec = await ensureTab(state, deps, tabId, {
      cwdOverride: cwd,
      initialModel: nextModel || previousModel,
    });
    changedModel = rec.session.model
      ? `${rec.session.model.provider}/${rec.session.model.id}`
      : "";
  } else {
    // Warm the profile's services so a later global read (usage fetch, model
    // registry) sees the freshly-selected creds — without touching the tab's
    // session or model (the worker owns those).
    servicesForProfile(state, profile.id, { forceRefresh: true });
  }

  deps.send({
    type: "auth_profile_changed",
    tabId,
    profileId: profile.id,
    model: changedModel,
  });
  emitAuthProfiles(state, deps);
  await emitGlobalReady(state, deps);
}

/**
 * Apply an account switch inside a per-tab WORKER bridge. The global bridge
 * owns the auth surface (snapshot + `auth_profile_changed` emit) via
 * {@link handleUseForTab}, but a worker runs that tab's prompts in a
 * separate process and never sees `auth_profile_use_for_tab`. The frontend
 * relays the switch here (tab-scoped routing) so the worker rebuilds its
 * session against the new profile's credentials — otherwise the worker
 * keeps using the old account and a rate-limited account never recovers.
 *
 * Deliberately silent: no snapshot/ready emit (those would be a partial,
 * worker-local view that clobbers the global activeByTab). Just swaps the
 * session so the next prompt uses the new account.
 */
export async function handleApplyForTab(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = stringField(msg.tabId);
  const profileId = stringField(msg.profileId);
  if (!tabId || !profileId) return;
  // The profile may have been created after this worker spawned; reload the
  // persisted profile list so the lookup succeeds.
  state.authProfiles = loadAuthProfilesState(state.userDir);
  const profile = state.authProfiles.profiles.find((p) => p.id === profileId);
  if (!profile) return;
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
  // Prefer the cwd/model carried by the message — when this relay is what
  // spawns an idle-retired/never-spawned worker, `existing` is undefined, so
  // the recorded cwd may be missing (wrong-workspace fallback) and there is
  // no previous model (silent reset to the default model).
  const msgCwd = stringField(msg.cwd);
  const cwd = msgCwd || state.tabProjectCwds.get(tabId);
  if (existing) clearPendingContextUsageEmit(existing);
  state.tabs.delete(tabId);
  state.tabAuthProfileIds.set(tabId, profile.id);
  const services = servicesForProfile(state, profile.id, {
    forceRefresh: true,
  });
  const desiredModel = previousModel ?? modelFromIdField(services, msg.model);
  const nextModel =
    desiredModel &&
    services.modelRegistry.find(desiredModel.provider, desiredModel.id);
  await ensureTab(state, deps, tabId, {
    cwdOverride: cwd,
    initialModel: nextModel || desiredModel,
  });
  markProfileUsed(state, profile.id);
  deps.send({
    type: "auth_profile_changed",
    tabId,
    profileId: profile.id,
  });
}

/**
 * Record a tab's account selection in the GLOBAL bridge's map without
 * touching the session or re-emitting. The frontend relays every
 * `auth_profile_changed` here so the global bridge's `tabAuthProfileIds`
 * stays in sync with worker-side switches (e.g. usage-limit auto-switch) —
 * otherwise a later global `auth_profiles` snapshot would revert the tab to
 * the stale account. Deliberately emit-free so it can't loop with the
 * `auth_profile_changed` that triggered it.
 */
export function handleRecordForTab(
  state: AethonAgentState,
  msg: InboundMessage,
): void {
  const tabId = stringField(msg.tabId);
  const profileId = stringField(msg.profileId);
  if (!tabId || !profileId) return;
  if (!state.authProfiles.profiles.some((p) => p.id === profileId)) {
    state.authProfiles = loadAuthProfilesState(state.userDir);
    if (!state.authProfiles.profiles.some((p) => p.id === profileId)) return;
  }
  state.tabAuthProfileIds.set(tabId, profileId);
}

/** Resolve a `provider/id` model string (from an apply payload) against a
 *  profile's registry, so a respawned worker keeps the tab's current model
 *  instead of falling back to the default. */
function modelFromIdField(
  services: AuthProfileServices,
  field: unknown,
): Model<Api> | undefined {
  const id = stringField(field);
  if (!id.includes("/")) return undefined;
  const [provider, ...rest] = id.split("/");
  return services.modelRegistry.find(provider, rest.join("/")) ?? undefined;
}

export function targetTabIdFromMessage(
  msg: InboundMessage,
): string | undefined {
  return normalizedTabId(msg.tabId);
}
