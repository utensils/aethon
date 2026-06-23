import type { AethonAgentState } from "../state";
import {
  deleteProfileFiles,
  isSafeProfileId,
  loadAuthProfilesState,
  saveAuthProfilesState,
  type AuthProfileMeta,
  type AuthProfilesState,
} from "./store";

export function loadAuthProfiles(userDir: string): AuthProfilesState {
  return loadAuthProfilesState(userDir);
}

export function saveAuthProfiles(state: AethonAgentState): void {
  saveAuthProfilesState(state.userDir, state.authProfiles);
}

export function findProfile(
  state: AethonAgentState,
  profileId: string,
): AuthProfileMeta | undefined {
  if (!profileId || !isSafeProfileId(profileId)) return undefined;
  return state.authProfiles.profiles.find((p) => p.id === profileId);
}

export function removeProfile(
  state: AethonAgentState,
  profileId: string,
): void {
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

export function markProfileUsed(
  state: AethonAgentState,
  profileId: string,
): void {
  const now = Date.now();
  state.authProfiles = {
    ...state.authProfiles,
    profiles: state.authProfiles.profiles.map((p) =>
      p.id === profileId ? { ...p, lastUsedAt: now, updatedAt: now } : p,
    ),
  };
  saveAuthProfiles(state);
}

export function normalizedTabId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
