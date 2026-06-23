import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { emitGlobalReady } from "../dispatcherTypes";
import { createProfileMeta } from "./store";
import { servicesForProfile } from "./services-cache";
import {
  findProfile,
  removeProfile,
  saveAuthProfiles,
  stringField,
} from "./profile-state";
import { emitAuthProfiles } from "./snapshot";
import {
  refreshTabsAfterAuthChange,
  targetTabIdFromMessage,
} from "./tab-account-binding";

export async function handleApiKeySave(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const providerId = stringField(msg.providerId);
  const key = stringField(msg.key);
  if (!providerId || !key)
    throw new Error("auth_profile_api_key_save: providerId and key required");
  const targetTabId = targetTabIdFromMessage(msg);
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

export function handleSetDefault(
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

export function handleRename(
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

export function handleDelete(
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
