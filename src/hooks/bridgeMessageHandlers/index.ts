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
import { handleA2ui } from "./a2ui";
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
import { handleSessionHistory } from "./sessionHistory";
import { handleShellQuery } from "./shellQuery";
import { handleStatePatch } from "./statePatch";
import { handleTabClosed } from "./tabClosed";
import { handleTabReady } from "./tabReady";
import { handleTerminalOutput } from "./terminalOutput";

export const bridgeMessageHandlers: Readonly<
  Record<string, BridgeMessageHandler>
> = Object.freeze({
  a2ui: handleA2ui,
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
  session_history: handleSessionHistory,
  shell_query: handleShellQuery,
  state_patch: handleStatePatch,
  tab_closed: handleTabClosed,
  tab_ready: handleTabReady,
  terminal_output: handleTerminalOutput,
});

export type { BridgeMessage, BridgeMessageContext, BridgeMessageHandler } from "./types";
