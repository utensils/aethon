/**
 * The bridge's main inbound loop. Reads JSON-lines from stdin and routes
 * each message to the focused command-family handlers.
 */

import { createInterface } from "node:readline";
import type { AethonApi } from "./aethon-api";
import type { AethonAgentState, AethonExtensionApi } from "./state";
import { handleA2UIEvent } from "./a2uiEvents";
import {
  handleChat,
  handleSetCodexFastMode,
  handleSetModel,
  handleSetThinkingLevel,
  handleStop,
} from "./chat";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { emitGlobalReady, maybeExitForReload } from "./dispatcherTypes";
import { handleSetExtensionDisabled } from "./extensionControl";
import { ackMutation, markFrontendReady } from "./mutation-ack";
import { onDevshellEvent } from "./devshell";
import { handleSubagentsChanged } from "./subagents/changed";
import {
  applyProviderTimeoutOverride,
  applyRuntimeConfig,
  runtimeConfigFromConfig,
} from "./runtime-config";
import { handleForkSession, handleRollbackSession } from "./session-branch";
import { handleMirroredTabsChanged } from "./aethon-api-sessions";
import { handleNativeSlashCommand } from "./nativeSlash";
import { handleSetProject } from "./projectLifecycle";
import { handleAuthProfileMessage } from "./auth-profiles";
import {
  handleLocalChatMessage,
  handleSetSessionLabel,
  handleTabClose,
  handleTabOpen,
} from "./tabs";

function mirrorNativeWindowsFromFrontend(
  state: AethonAgentState,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  state.nativeWindows.clear();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as {
      id?: unknown;
      label?: unknown;
      kind?: unknown;
      title?: unknown;
      tabId?: unknown;
      restoreOnLaunch?: unknown;
      componentCount?: unknown;
    };
    if (
      typeof rec.id !== "string" ||
      typeof rec.label !== "string" ||
      rec.kind !== "canvas" ||
      typeof rec.title !== "string"
    ) {
      continue;
    }
    state.nativeWindows.set(rec.id, {
      id: rec.id,
      label: rec.label,
      kind: "canvas",
      title: rec.title,
      ...(typeof rec.tabId === "string" ? { tabId: rec.tabId } : {}),
      ...(typeof rec.restoreOnLaunch === "boolean"
        ? { restoreOnLaunch: rec.restoreOnLaunch }
        : {}),
      ...(typeof rec.componentCount === "number"
        ? { componentCount: rec.componentCount }
        : {}),
    });
  }
}

export type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
export {
  handleChat,
  handleSetCodexFastMode,
  handleSetModel,
  handleSetThinkingLevel,
  handleStop,
} from "./chat";
export {
  exportTargetForSlashCommand,
  formatContextUsageMessage,
  formatSessionStatsMessage,
} from "./nativeSlash";
export {
  captureProjectExtensionBaseline,
  unloadProjectExtensions,
} from "./projectLifecycle";

/** Run the inbound dispatcher loop. Returns when stdin closes. */
export async function runDispatcher(
  state: AethonAgentState,
  deps: DispatcherDeps,
  aethonApi: AethonApi,
  extensionApi: AethonExtensionApi,
): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: InboundMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      deps.send({ type: "error", message: "invalid JSON" });
      continue;
    }

    await dispatchInboundMessage(state, deps, aethonApi, extensionApi, msg);
  }
}

export async function dispatchInboundMessage(
  state: AethonAgentState,
  deps: DispatcherDeps,
  aethonApi: AethonApi,
  extensionApi: AethonExtensionApi,
  msg: InboundMessage,
): Promise<void> {
  const notifDeps = { send: deps.send };
  try {
    if (await handleAuthProfileMessage(state, deps, msg)) return;

    switch (msg.type) {
      case "chat":
        await handleChat(state, deps, msg);
        break;
      case "set_model":
        await handleSetModel(state, deps, msg);
        break;
      case "set_thinking_level":
        await handleSetThinkingLevel(state, deps, msg);
        break;
      case "set_codex_fast_mode":
        handleSetCodexFastMode(state, deps, msg);
        break;
      case "stop":
        handleStop(state, deps, msg);
        break;
      case "native_slash_command":
        await handleNativeSlashCommand(state, deps, msg);
        break;
      case "tab_open":
        await handleTabOpen(state, deps, extensionApi, msg);
        break;
      case "set_project":
        await handleSetProject(state, deps, extensionApi, notifDeps, msg);
        break;
      case "tab_close":
        handleTabClose(state, deps, msg);
        break;
      case "report":
        markFrontendReady(state);
        await emitGlobalReady(state, deps);
        break;
      case "reload_request":
        // Rust file-watcher asked us to reload because an extension file
        // changed. Drain in-flight prompts before cleanly exiting.
        state.reloadPending = true;
        maybeExitForReload(state, deps);
        break;
      case "mutation_ack": {
        const mid = (msg as { mutationId?: unknown }).mutationId;
        const success = (msg as { success?: unknown }).success;
        const errorField = (msg as { error?: unknown }).error;
        const dataField = (msg as { data?: unknown }).data;
        if (typeof mid !== "string") break;
        ackMutation(
          state,
          mid,
          success === undefined ? true : !!success,
          typeof errorField === "string" ? errorField : undefined,
          dataField,
        );
        break;
      }
      case "a2ui_event":
        await handleA2UIEvent(state, deps, aethonApi, msg);
        break;
      case "register_component":
        if (!msg.componentType) {
          deps.send({
            type: "error",
            message: "register_component: missing componentType",
          });
          break;
        }
        aethonApi.registerComponent(msg.componentType, msg.template);
        break;
      case "set_state":
        if (!msg.path) {
          deps.send({ type: "error", message: "set_state: missing path" });
          break;
        }
        aethonApi.setState(msg.path, msg.value);
        break;
      case "set_layout":
        if (!msg.payload) {
          deps.send({
            type: "error",
            message: "set_layout: missing payload",
          });
          break;
        }
        aethonApi.setLayout(msg.payload);
        break;
      case "patch_layout":
        if (!msg.path) {
          deps.send({
            type: "error",
            message: "patch_layout: missing path",
          });
          break;
        }
        aethonApi.patchLayout(msg.path, msg.value);
        break;
      case "register_theme":
        if (!msg.theme) {
          deps.send({
            type: "error",
            message: "register_theme: missing theme",
          });
          break;
        }
        aethonApi.registerTheme(msg.theme);
        break;
      case "frontend_state_patch":
        if (!msg.path || typeof msg.path !== "string") break;
        {
          const previous = state.frontendState.get(msg.path);
          state.frontendState.set(msg.path, msg.value);
          if (msg.path === "/nativeWindows") {
            mirrorNativeWindowsFromFrontend(state, msg.value);
          } else if (msg.path === "/tabs") {
            handleMirroredTabsChanged(state, previous, msg.value);
          }
        }
        deps.scheduleStateFileWrite();
        break;
      case "boot_layout":
        if (!msg.payload || typeof msg.payload !== "object") {
          deps.send({
            type: "error",
            message: "boot_layout: missing or invalid payload",
          });
          break;
        }
        state.bootLayout = msg.payload;
        break;
      case "set_extension_disabled":
        await handleSetExtensionDisabled(state, deps, notifDeps, msg);
        break;
      case "set_session_label":
        await handleSetSessionLabel(state, deps, msg);
        break;
      case "local_chat_message":
        await handleLocalChatMessage(state, deps, msg);
        break;
      case "subagents_changed":
        await handleSubagentsChanged(state, deps);
        break;
      case "runtime_config_changed":
        applyRuntimeConfig(state, runtimeConfigFromConfig(msg.config));
        applyProviderTimeoutOverride(state);
        break;
      case "rollback_session":
        await handleRollbackSession(state, deps, msg);
        break;
      case "fork_session":
        await handleForkSession(state, deps, msg);
        break;
      case "devshell_event": {
        const status = msg.devshellStatus;
        const root = msg.devshellRoot;
        const kind = msg.devshellKind ?? "auto";
        if (
          typeof root === "string" &&
          root.length > 0 &&
          (status === "ready" || status === "failed" || status === "resolving")
        ) {
          onDevshellEvent(state, deps, { kind, root, status });
        }
        break;
      }
      default:
        deps.send({
          type: "error",
          message: `unknown message type: ${msg.type}`,
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({ type: "error", message });
  }
}
