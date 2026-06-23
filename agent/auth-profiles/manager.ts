import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import {
  handleApiKeySave,
  handleDelete,
  handleRename,
  handleSetDefault,
} from "./profile-commands";
import {
  handleOAuthCancel,
  handleOAuthInput,
  handleOAuthStart,
} from "./oauth-flow";
import {
  handleApplyForTab,
  handleRecordForTab,
  handleUseForTab,
} from "./tab-account-binding";
import { handleFetchUsage } from "./usage-limit-recovery";
import { emitAuthProfiles } from "./snapshot";

export type {
  AuthProfileProvider,
  AuthProfileServices,
  AuthProfilesSnapshot,
} from "./types";
export { loadAuthProfiles, saveAuthProfiles } from "./profile-state";
export {
  authProfileServicesForTab,
  defaultProfileIdForTab,
  modelRegistryForModelId,
  refreshAuthServicesForTab,
  refreshGlobalAuthServicesIfChanged,
  refreshTabSessionModelFromAuthServices,
  servicesForProvider,
} from "./services-cache";
export { authProfilesSnapshot, emitAuthProfiles } from "./snapshot";
export { authRefreshTabIds } from "./tab-account-binding";
export {
  parseIdTokenEmail,
  tryAutoSwitchOnUsageLimit,
} from "./usage-limit-recovery";

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
    case "auth_profile_apply":
      await handleApplyForTab(state, deps, msg);
      return true;
    case "auth_profile_record":
      handleRecordForTab(state, msg);
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
