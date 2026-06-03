/** Bridge-message handler registry. Maps each `data.type` value the
 *  agent bridge can emit to its handler. Adding a new bridge message:
 *
 *    1. Create `bridgeMessageHandlers/<name>.ts` exporting a handler
 *       of type `BridgeMessageHandler`.
 *    2. Register it here.
 *    3. Add a happy-path test in `bridgeMessageHandlers/<name>.test.ts`.
 *
 *  The hook (useBridgeMessages) does the lookup; an unknown type is a
 *  silent no-op (matches the previous switch-statement fall-through). */
import type { BridgeMessageHandler } from "./types";
import {
  handleAuthProfileChanged,
  handleAuthProfileLoginEvent,
  handleAuthProfiles,
} from "./authProfiles";
import { handleA2ui } from "./a2ui";
import { handleContextUsage } from "./contextUsage";
import { handleEntryIds } from "./entryIds";
import { handleError } from "./error";
import { handleExtensionComponents } from "./extensionComponents";
import { handleExtensionEventRoutes } from "./extensionEventRoutes";
import { handleExtensionFrontendModules } from "./extensionFrontendModules";
import { handleExtensionKeybindings } from "./extensionKeybindings";
import { handleExtensionLayouts } from "./extensionLayouts";
import { handleExtensionLifecycle } from "./extensionLifecycle";
import { handleExtensionMenuItems } from "./extensionMenuItems";
import { handleExtensionRuntimeError } from "./extensionRuntimeError";
import { handleExtensionSlashCommands } from "./extensionSlashCommands";
import { handleExtensionThemes } from "./extensionThemes";
import { handleLayoutPatch } from "./layoutPatch";
import { handleLayoutSet } from "./layoutSet";
import { handleModelChanged } from "./modelChanged";
import { handleNativeSlashResult } from "./nativeSlashResult";
import { handleNotice } from "./notice";
import { handleNotification } from "./notification";
import { handleNotificationDismiss } from "./notificationDismiss";
import { handlePromptStarted } from "./promptStarted";
import { handleQueueReset } from "./queueReset";
import { handleQueued } from "./queued";
import { handleReady } from "./ready";
import { handleReloadRequired } from "./reloadRequired";
import { handleRegisterHighlightGrammar } from "./registerHighlightGrammar";
import { handleResponse } from "./response";
import { handleResponseDelta } from "./responseDelta";
import { handleResponseEnd } from "./responseEnd";
import { handleSessionForked } from "./sessionForked";
import { handleSessionHistory } from "./sessionHistory";
import { handleSessionRolledBack } from "./sessionRolledBack";
import { handleShellQuery } from "./shellQuery";
import { handleDashboardQuery } from "./dashboardQuery";
import { handleDevshellQuery } from "./devshellQuery";
import { handleGitQuery } from "./gitQuery";
import { handleStatePatch } from "./statePatch";
import { handleTabClosed } from "./tabClosed";
import { handleTabReady } from "./tabReady";
import { handleTerminalOutput } from "./terminalOutput";

export const bridgeMessageHandlers: Readonly<
  Record<string, BridgeMessageHandler>
> = Object.freeze({
  a2ui: handleA2ui,
  auth_profile_changed: handleAuthProfileChanged,
  auth_profile_login_event: handleAuthProfileLoginEvent,
  auth_profiles: handleAuthProfiles,
  context_usage: handleContextUsage,
  entry_ids: handleEntryIds,
  error: handleError,
  extension_components: handleExtensionComponents,
  extension_event_routes: handleExtensionEventRoutes,
  extension_frontend_modules: handleExtensionFrontendModules,
  extension_keybindings: handleExtensionKeybindings,
  extension_layouts: handleExtensionLayouts,
  extension_lifecycle: handleExtensionLifecycle,
  extension_menu_items: handleExtensionMenuItems,
  extension_runtime_error: handleExtensionRuntimeError,
  extension_slash_commands: handleExtensionSlashCommands,
  extension_themes: handleExtensionThemes,
  layout_patch: handleLayoutPatch,
  layout_set: handleLayoutSet,
  model_changed: handleModelChanged,
  native_slash_result: handleNativeSlashResult,
  notice: handleNotice,
  notification: handleNotification,
  notification_dismiss: handleNotificationDismiss,
  prompt_started: handlePromptStarted,
  queue_reset: handleQueueReset,
  queued: handleQueued,
  ready: handleReady,
  reload_required: handleReloadRequired,
  register_highlight_grammar: handleRegisterHighlightGrammar,
  response: handleResponse,
  response_delta: handleResponseDelta,
  response_end: handleResponseEnd,
  session_forked: handleSessionForked,
  session_history: handleSessionHistory,
  session_rolled_back: handleSessionRolledBack,
  shell_query: handleShellQuery,
  dashboard_query: handleDashboardQuery,
  devshell_query: handleDevshellQuery,
  git_query: handleGitQuery,
  state_patch: handleStatePatch,
  tab_closed: handleTabClosed,
  tab_ready: handleTabReady,
  terminal_output: handleTerminalOutput,
});

export type { BridgeMessage, BridgeMessageContext, BridgeMessageHandler } from "./types";
