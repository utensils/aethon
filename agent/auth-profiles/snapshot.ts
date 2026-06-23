import type { AethonAgentState } from "../state";
import type { DispatcherDeps } from "../dispatcherTypes";
import { authProfileProviders } from "./services-cache";
import type { AuthProfilesSnapshot } from "./types";

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

export function emitAuthProfiles(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
): void {
  deps.send({
    type: "auth_profiles",
    authProfiles: authProfilesSnapshot(state),
  });
}
