/**
 * The bridge's main inbound loop. Reads JSON-lines from stdin and
 * dispatches them to:
 *   - tab-lifecycle (chat / set_model / stop / tab_open / tab_close /
 *     set_project / report)
 *   - aethon-api (register_component / set_state / set_layout / etc.)
 *   - mutation-ack (mutation_ack)
 *   - the runtime snapshot + ready (report)
 *
 * Plus the project-extension teardown/load on cwd change, the
 * `boot_layout` and `frontend_state_patch` mirror handlers, and the
 * a2ui_event handler dispatch (matched against state.a2uiEventHandlers).
 */

import { createInterface } from "node:readline";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AethonAgentState,
  ProjectBaselineSnapshot,
  AethonExtensionApi,
  ExtensionFailure,
  ExtensionFailureSource,
  PiHandlerCtx,
  TabRecord,
} from "./state";
import type { AethonApi } from "./aethon-api";
import { logger } from "./logger";
import {
  ackMutation,
  markFrontendReady,
} from "./mutation-ack";
import { dismissNotification, notify } from "./notifications";
import { setState, makeCanvasApi } from "./state-mutation";
import {
  emitReady,
  ensurePickerHasModel,
  ensureTab,
  modelKey,
  tabSessionDir,
} from "./tab-lifecycle";
import {
  loadProjectAethonExtensions,
} from "./extension-loader";
import { patchLayoutTree } from "./layout-manager";
import {
  readSessionMetadata,
  readSessionTranscript,
  writeSessionLabel,
} from "./session-history";
import { saveDisabledExtensions } from "./disabled-extensions";

export interface DispatcherDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
  /** Persistent extension hooks shared across all loaders so the failures
   *  registry stays in sync with the lifecycle events. */
  loadHooks: {
    onLoaded?: (name: string) => void;
    onFailure?: (
      f: ExtensionFailure & { name: string; source: ExtensionFailureSource },
    ) => void;
  };
}

/** Capture a baseline snapshot of every registry an extension can write
 *  into. Captured AFTER user-level + extension-package + pi-extension
 *  loaders run, BEFORE any project-directory extension runs.
 *  `unloadProjectExtensions` restores the live registries from these
 *  snapshots, then re-emits the hydrate messages so the frontend drops
 *  the project's contributions. */
export function captureProjectExtensionBaseline(
  state: AethonAgentState,
): ProjectBaselineSnapshot {
  const snapshot: ProjectBaselineSnapshot = {
    components: new Map(state.extensionComponents),
    themes: new Map(state.extensionThemes),
    slashCommands: new Map(state.extensionSlashCommands),
    keybindings: new Map(state.extensionKeybindings),
    menuItems: new Map(state.extensionMenuItems),
    layouts: new Map(state.extensionLayouts),
    eventRoutes: new Map(state.extensionEventRoutes),
    eventRoutingMode: state.eventRoutingMode,
    eventHandlerCount: state.a2uiEventHandlers.length,
    handlerDedupeKeys: [...state.registeredHandlerKeys],
    stateTree: JSON.parse(JSON.stringify(state.extensionStateTree)) as Record<
      string,
      unknown
    >,
    extensionLayout:
      state.extensionLayout === undefined
        ? undefined
        : JSON.parse(JSON.stringify(state.extensionLayout)),
    pendingLayoutPatches: state.pendingLayoutPatches.map((p) => ({
      path: p.path,
      value: p.value,
    })),
  };
  state.projectBaseline = snapshot;
  return snapshot;
}

/** Restore every registry to the post-non-project-load baseline. Used
 *  before loading a different project's extensions so we don't leak
 *  project A's components / themes / slash commands into project B. */
export function unloadProjectExtensions(
  state: AethonAgentState,
  deps: DispatcherDeps,
): void {
  if (!state.projectBaseline) return;
  // Run any teardown callbacks the extension scheduled via
  // `aethon.onUnload(fn)`. Without it those keep mutating shared state
  // after the project boundary "unloaded" the registries.
  if (state.projectExtensionTeardowns.length > 0) {
    const log = logger.scope("project-switch");
    for (const fn of state.projectExtensionTeardowns) {
      try {
        const result = fn();
        if (
          result &&
          typeof (result as Promise<unknown>).catch === "function"
        ) {
          (result as Promise<unknown>).catch((err: unknown) => {
            log.warn(`teardown async error: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        log.warn(`teardown sync error: ${(err as Error).message}`);
      }
    }
    state.projectExtensionTeardowns.length = 0;
  }
  for (const [name, source] of state.loadedExtensions) {
    if (source === "project-directory") state.loadedExtensions.delete(name);
  }
  for (const [name, info] of state.loadFailures) {
    if (info.source === "project-directory") state.loadFailures.delete(name);
  }
  state.loadedProjectExtensionFiles.clear();
  state.failedProjectExtensionFiles.clear();

  state.extensionComponents.clear();
  for (const [k, v] of state.projectBaseline.components) {
    state.extensionComponents.set(k, v);
  }
  state.extensionThemes.clear();
  for (const [k, v] of state.projectBaseline.themes) {
    state.extensionThemes.set(k, v);
  }
  state.extensionSlashCommands.clear();
  for (const [k, v] of state.projectBaseline.slashCommands) {
    state.extensionSlashCommands.set(k, v);
  }
  state.extensionKeybindings.clear();
  for (const [k, v] of state.projectBaseline.keybindings) {
    state.extensionKeybindings.set(k, v);
  }
  state.extensionMenuItems.clear();
  for (const [k, v] of state.projectBaseline.menuItems) {
    state.extensionMenuItems.set(k, v);
  }
  state.extensionLayouts.clear();
  for (const [k, v] of state.projectBaseline.layouts) {
    state.extensionLayouts.set(k, v);
  }
  state.extensionEventRoutes.clear();
  for (const [k, v] of state.projectBaseline.eventRoutes) {
    state.extensionEventRoutes.set(k, v);
  }
  state.a2uiEventHandlers.length = state.projectBaseline.eventHandlerCount;
  state.registeredHandlerKeys.clear();
  for (const k of state.projectBaseline.handlerDedupeKeys) {
    state.registeredHandlerKeys.add(k);
  }
  state.eventRoutingMode = state.projectBaseline.eventRoutingMode;
  state.extensionStateTree = JSON.parse(
    JSON.stringify(state.projectBaseline.stateTree),
  ) as Record<string, unknown>;
  state.extensionLayout =
    state.projectBaseline.extensionLayout === undefined
      ? undefined
      : JSON.parse(JSON.stringify(state.projectBaseline.extensionLayout));
  state.pendingLayoutPatches = state.projectBaseline.pendingLayoutPatches.map(
    (p) => ({ path: p.path, value: p.value }),
  );

  deps.send({
    type: "extension_components",
    components: Object.fromEntries(state.extensionComponents),
  });
  deps.send({
    type: "extension_themes",
    themes: [...state.extensionThemes.values()].map((t) => ({
      id: t.id,
      label: t.label,
      vars: t.vars,
    })),
  });
  deps.send({
    type: "extension_slash_commands",
    commands: [...state.extensionSlashCommands.values()],
  });
  deps.send({
    type: "extension_keybindings",
    bindings: [...state.extensionKeybindings.values()],
  });
  deps.send({
    type: "extension_menu_items",
    items: [...state.extensionMenuItems.values()],
  });
  deps.send({
    type: "extension_layouts",
    layouts: [...state.extensionLayouts.values()],
  });
  deps.send({
    type: "extension_event_routes",
    routes: [...state.extensionEventRoutes.values()],
    mode: state.eventRoutingMode,
  });
  // Push the restored layout to the frontend.
  const effective = (() => {
    if (state.extensionLayout) return state.extensionLayout;
    if (!state.bootLayout) return null;
    if (state.pendingLayoutPatches.length === 0) return state.bootLayout;
    let tree = state.bootLayout;
    for (const { path, value } of state.pendingLayoutPatches) {
      tree = patchLayoutTree(tree, path, value);
    }
    return tree;
  })();
  if (effective) {
    deps.send({ type: "layout_set", payload: effective });
  }
  deps.scheduleStateFileWrite();
}

interface InboundMessage {
  type: string;
  content?: string;
  id?: string;
  tabId?: string;
  componentType?: string;
  template?: unknown;
  path?: string;
  value?: unknown;
  payload?: unknown;
  theme?: unknown;
  mutationId?: string;
  success?: boolean;
  error?: string;
  event?: {
    componentId?: string;
    componentType?: string;
    templateRootType?: string;
    eventType?: string;
    data?: unknown;
  };
}

/** Run the inbound dispatcher loop. Returns when stdin closes. */
export async function runDispatcher(
  state: AethonAgentState,
  deps: DispatcherDeps,
  aethonApi: AethonApi,
  extensionApi: AethonExtensionApi,
): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const stateMutationDeps = { send: deps.send };
  const notifDeps = { send: deps.send };

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

    try {
      switch (msg.type) {
        case "chat":
          await handleChat(state, deps, msg);
          break;
        case "set_model":
          await handleSetModel(state, deps, msg);
          break;
        case "stop":
          handleStop(state, deps, msg);
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
        case "report": {
          markFrontendReady(state);
          emitReady(state, deps);
          break;
        }
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
        case "register_component": {
          if (!msg.componentType) {
            deps.send({
              type: "error",
              message: "register_component: missing componentType",
            });
            break;
          }
          aethonApi.registerComponent(msg.componentType, msg.template);
          break;
        }
        case "set_state": {
          if (!msg.path) {
            deps.send({ type: "error", message: "set_state: missing path" });
            break;
          }
          aethonApi.setState(msg.path, msg.value);
          break;
        }
        case "set_layout": {
          if (!msg.payload) {
            deps.send({
              type: "error",
              message: "set_layout: missing payload",
            });
            break;
          }
          aethonApi.setLayout(msg.payload);
          break;
        }
        case "patch_layout": {
          if (!msg.path) {
            deps.send({
              type: "error",
              message: "patch_layout: missing path",
            });
            break;
          }
          aethonApi.patchLayout(msg.path, msg.value);
          break;
        }
        case "register_theme": {
          if (!msg.theme) {
            deps.send({
              type: "error",
              message: "register_theme: missing theme",
            });
            break;
          }
          aethonApi.registerTheme(msg.theme);
          break;
        }
        case "frontend_state_patch": {
          if (!msg.path || typeof msg.path !== "string") break;
          state.frontendState.set(msg.path, msg.value);
          deps.scheduleStateFileWrite();
          break;
        }
        case "boot_layout": {
          if (!msg.payload || typeof msg.payload !== "object") {
            deps.send({
              type: "error",
              message: "boot_layout: missing or invalid payload",
            });
            break;
          }
          state.bootLayout = msg.payload;
          break;
        }
        case "set_extension_disabled": {
          await handleSetExtensionDisabled(state, deps, notifDeps, msg);
          break;
        }
        case "set_session_label": {
          await handleSetSessionLabel(state, deps, msg);
          break;
        }
        default: {
          deps.send({
            type: "error",
            message: `unknown message type: ${msg.type}`,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", message });
    }
  }

  // ---- Per-message handlers -------------------------------------------

  async function handleChat(
    state: AethonAgentState,
    deps: DispatcherDeps,
    msg: InboundMessage,
  ): Promise<void> {
    if (!msg.content) {
      deps.send({ type: "error", message: "chat: missing content" });
      return;
    }
    const tabId = msg.tabId ?? "default";
    const tab = await ensureTab(state, deps, tabId);
    const queued = tab.promptInFlight;
    if (!queued) {
      tab.promptInFlight = true;
      tab.agentEndFired = false;
    } else {
      tab.queuedCount += 1;
    }
    if (!queued) state.currentAgentTabId = tabId;
    const content = msg.content;
    state.tabContext
      .run(tabId, () =>
        tab.session.prompt(
          content,
          queued ? { streamingBehavior: "followUp" } : undefined,
        ),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({ type: "error", tabId, message: `prompt: ${message}` });
      })
      .finally(() => {
        if (!queued && !tab.agentEndFired) {
          tab.promptInFlight = false;
          deps.send({ type: "response_end", tabId });
        }
        if (!queued && state.currentAgentTabId === tabId) {
          state.currentAgentTabId = undefined;
        }
      });
    if (queued) {
      deps.send({ type: "queued", tabId });
    }
  }

  async function handleSetModel(
    state: AethonAgentState,
    deps: DispatcherDeps,
    msg: InboundMessage,
  ): Promise<void> {
    if (!msg.id) {
      deps.send({ type: "error", message: "set_model: missing id" });
      return;
    }
    const tabId = msg.tabId ?? "default";
    const tab = await ensureTab(state, deps, tabId);
    if (tab.promptInFlight) {
      deps.send({
        type: "notice",
        tabId,
        message:
          "agent busy — stop the current prompt before switching models",
      });
      return;
    }
    const [provider, ...rest] = msg.id.split("/");
    const id = rest.join("/");
    const next = state.modelRegistry.find(provider, id);
    if (!next) {
      deps.send({
        type: "error",
        tabId,
        message: `set_model: unknown model ${msg.id}`,
      });
      return;
    }
    await tab.session.setModel(next);
    ensurePickerHasModel(state, deps, next);
    deps.send({ type: "model_changed", tabId, model: msg.id });
  }

  function handleStop(
    state: AethonAgentState,
    deps: DispatcherDeps,
    msg: InboundMessage,
  ): void {
    const tabId = msg.tabId ?? "default";
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (
      typeof (tab.session as { clearQueue?: () => unknown }).clearQueue ===
      "function"
    ) {
      try {
        (tab.session as { clearQueue: () => unknown }).clearQueue();
      } catch {
        /* best effort */
      }
    }
    tab.queuedCount = 0;
    deps.send({ type: "queue_reset", tabId });
    tab.session.abort().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", tabId, message: `abort: ${message}` });
    });
  }

  async function handleTabOpen(
    state: AethonAgentState,
    deps: DispatcherDeps,
    extensionApi: AethonExtensionApi,
    msg: InboundMessage,
  ): Promise<void> {
    const tabId = msg.tabId;
    if (!tabId || typeof tabId !== "string") {
      deps.send({ type: "error", message: "tab_open: missing tabId" });
      return;
    }
    const modelId = (msg as { model?: unknown }).model;
    let initialModel: Model<Api> | undefined;
    if (typeof modelId === "string" && modelId.length > 0) {
      const [provider, ...rest] = modelId.split("/");
      initialModel =
        state.modelRegistry.find(provider, rest.join("/")) ?? undefined;
    }
    const cwdField = (msg as { cwd?: unknown }).cwd;
    const cwdOverride =
      typeof cwdField === "string" && cwdField.length > 0
        ? cwdField
        : undefined;
    if (cwdOverride) {
      const projectChanged = cwdOverride !== state.currentProjectCwd;
      if (projectChanged) {
        unloadProjectExtensions(state, deps);
      }
      const result = await loadProjectAethonExtensions(
        state,
        deps,
        cwdOverride,
        extensionApi,
        state.loadedExtensions,
        state.loadedProjectExtensionFiles,
        state.failedProjectExtensionFiles,
        deps.loadHooks,
      );
      state.currentProjectCwd = cwdOverride;
      if (result.loaded > 0 || result.failed > 0 || projectChanged) {
        await state.resourceLoader.reload();
        deps.scheduleStateFileWrite();
        emitReady(state, deps);
      }
    }
    const restoreHistory =
      (msg as { restoreHistory?: unknown }).restoreHistory === true;
    let restoredMessages: Awaited<ReturnType<typeof readSessionTranscript>> = [];
    if (restoreHistory) {
      try {
        restoredMessages = await readSessionTranscript(
          tabSessionDir(state, tabId),
        );
      } catch (err) {
        deps.send({
          type: "error",
          tabId,
          message: `session restore: ${(err as Error).message}`,
        });
      }
    }
    await ensureTab(state, deps, tabId, { initialModel, cwdOverride });
    if (restoreHistory) {
      deps.send({ type: "session_history", tabId, messages: restoredMessages });
    }
  }

  async function handleSetProject(
    state: AethonAgentState,
    deps: DispatcherDeps,
    extensionApi: AethonExtensionApi,
    notifDeps: { send: (m: Record<string, unknown>) => void },
    msg: InboundMessage,
  ): Promise<void> {
    const tabId = (msg as { tabId?: unknown }).tabId;
    const cwd = (msg as { cwd?: unknown }).cwd;
    if (typeof tabId !== "string" || tabId.length === 0) {
      deps.send({ type: "error", message: "set_project: missing tabId" });
      return;
    }
    if (cwd === null) {
      state.tabProjectCwds.delete(tabId);
      if (state.currentProjectCwd !== null) {
        unloadProjectExtensions(state, deps);
        state.currentProjectCwd = null;
        await state.resourceLoader.reload();
        deps.scheduleStateFileWrite();
        emitReady(state, deps);
      }
      return;
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      deps.send({ type: "error", message: "set_project: cwd must be string|null" });
      return;
    }
    state.tabProjectCwds.set(tabId, cwd);
    const projectChanged = cwd !== state.currentProjectCwd;
    const t0 = projectChanged ? Date.now() : 0;
    if (projectChanged) {
      unloadProjectExtensions(state, deps);
      logger
        .scope("project-switch")
        .info(`set_project unload took ${Date.now() - t0}ms (cwd=${cwd})`);
    }
    const projectName = cwd.split("/").pop() || cwd;
    const loadingNoticeId = `aethon:loading-project-ext:${cwd}`;
    const loadingNoticeTimer = projectChanged
      ? setTimeout(() => {
          void notify(state, notifDeps, {
            id: loadingNoticeId,
            title: `Loading ${projectName} extensions…`,
            kind: "info",
            durationMs: null,
          });
        }, 500)
      : null;
    const tLoad = Date.now();
    const result = await loadProjectAethonExtensions(
      state,
      deps,
      cwd,
      extensionApi,
      state.loadedExtensions,
      state.loadedProjectExtensionFiles,
      state.failedProjectExtensionFiles,
      deps.loadHooks,
    );
    if (loadingNoticeTimer !== null) {
      clearTimeout(loadingNoticeTimer);
      void dismissNotification(state, notifDeps, loadingNoticeId);
    }
    if (projectChanged) {
      logger
        .scope("project-switch")
        .info(
          `set_project load took ${Date.now() - tLoad}ms (loaded=${result.loaded} failed=${result.failed})`,
        );
    }
    state.currentProjectCwd = cwd;
    if (result.loaded > 0 || result.failed > 0 || projectChanged) {
      const tReload = Date.now();
      await state.resourceLoader.reload();
      if (projectChanged) {
        logger
          .scope("project-switch")
          .info(
            `set_project resourceLoader.reload took ${Date.now() - tReload}ms`,
          );
      }
      deps.scheduleStateFileWrite();
      emitReady(state, deps);
      if (projectChanged) {
        logger
          .scope("project-switch")
          .info(`set_project total ${Date.now() - t0}ms (cwd=${cwd})`);
      }
    }
  }

  function handleTabClose(
    state: AethonAgentState,
    deps: DispatcherDeps,
    msg: InboundMessage,
  ): void {
    const tabId = msg.tabId;
    if (!tabId || typeof tabId !== "string") {
      deps.send({ type: "error", message: "tab_close: missing tabId" });
      return;
    }
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (tab.promptInFlight) {
      tab.session.abort().catch(() => {
        /* fire-and-forget — we're tearing down anyway */
      });
    }
    state.tabs.delete(tabId);
    state.tabProjectCwds.delete(tabId);
    if (state.currentAgentTabId === tabId) {
      state.currentAgentTabId = undefined;
    }
    deps.send({ type: "tab_closed", tabId });
  }

  async function handleSetExtensionDisabled(
    state: AethonAgentState,
    deps: DispatcherDeps,
    notifDeps: { send: (m: Record<string, unknown>) => void },
    msg: InboundMessage,
  ): Promise<void> {
    const name = (msg as { name?: unknown }).name;
    const disabled = (msg as { disabled?: unknown }).disabled;
    if (typeof name !== "string" || !name) {
      deps.send({
        type: "error",
        message: "set_extension_disabled: name required",
      });
      return;
    }
    if (typeof disabled !== "boolean") {
      deps.send({
        type: "error",
        message: "set_extension_disabled: disabled must be boolean",
      });
      return;
    }
    const wasDisabled = state.disabledExtensions.has(name);
    if (disabled === wasDisabled) return; // no-op
    if (disabled) state.disabledExtensions.add(name);
    else state.disabledExtensions.delete(name);
    await saveDisabledExtensions(state.userDir, state.disabledExtensions);
    // Surface the change to the frontend immediately. The loaded set
    // doesn't change until restart; the sidebar shows a `(disabled)` row
    // by deriving from `loadedExtensions ∩ ¬disabledExtensions` plus the
    // explicit disabled list. We re-emit the lifecycle event so the
    // hydration handler can move the row to the right bucket.
    deps.send({
      type: "extension_lifecycle",
      name,
      source: "directory",
      status: disabled ? "disabled" : "enabled",
    });
    // Notify the user before signalling the bridge restart so the toast
    // is rendered before agent-reloaded clears the in-flight UI state.
    void notify(state, notifDeps, {
      id: `aethon:extension-toggle:${name}`,
      title: disabled
        ? `Disabled \`${name}\``
        : `Enabled \`${name}\``,
      message: disabled
        ? "Reloading bridge to fully unload…"
        : "Reloading bridge to load…",
      kind: "info",
      durationMs: 4000,
    });
    // Ask the frontend to force-restart the bridge. We can't restart
    // ourselves from inside the bridge (the Tauri shell owns the child
    // and needs to flip its `agent_reload_in_progress` flag so the
    // supervisor emits `agent-reloaded` instead of `agent-crashed`).
    // The frontend's reload-required handler invokes `force_restart_agent`
    // — on respawn, the new bridge reads disabled-extensions.json on boot
    // and the loader honors it.
    deps.send({
      type: "reload_required",
      reason: `extension-toggle:${name}`,
    });
  }

  async function handleSetSessionLabel(
    state: AethonAgentState,
    deps: DispatcherDeps,
    msg: InboundMessage,
  ): Promise<void> {
    const tabId = (msg as { tabId?: unknown }).tabId;
    const labelField = (msg as { label?: unknown }).label;
    if (typeof tabId !== "string" || !tabId) {
      deps.send({
        type: "error",
        message: "set_session_label: tabId required",
      });
      return;
    }
    const label = typeof labelField === "string" ? labelField : "";
    try {
      await writeSessionLabel(tabSessionDir(state, tabId), label);
    } catch (err) {
      deps.send({
        type: "error",
        message: `set_session_label: ${(err as Error).message}`,
      });
      return;
    }
    // Refresh the discovered-tabs cache so the next emitReady (which the
    // frontend triggers by sending `report` after this command finishes)
    // reflects the new label. Cheap to re-read just the one entry.
    const refreshed = await readSessionMetadata(tabSessionDir(state, tabId));
    if (refreshed) {
      const idx = state.discoveredTabs.findIndex((t) => t.tabId === tabId);
      const entry = { tabId, ...refreshed };
      if (idx >= 0) state.discoveredTabs[idx] = entry;
      else state.discoveredTabs.push(entry);
    }
    emitReady(state, deps);
  }

  async function handleA2UIEvent(
    state: AethonAgentState,
    deps: DispatcherDeps,
    aethonApi: AethonApi,
    msg: InboundMessage,
  ): Promise<void> {
    const ev = msg.event ?? {};
    const descendantId = ev.componentId?.includes("__tpl__")
      ? ev.componentId.split("__tpl__").slice(1).join("__tpl__")
      : undefined;
    const handlerTabId = msg.tabId ?? "default";
    const handlerTab = await ensureTab(state, deps, handlerTabId);
    const piCtx = buildPiHandlerCtx(state, deps, handlerTab, handlerTabId);
    const tabScopedSetState = (path: string, value: unknown) =>
      setState(state, stateMutationDeps, path, value, handlerTabId);
    const tabScopedCanvas = makeCanvasApi(state, stateMutationDeps, handlerTabId);

    for (const { match, handler } of state.a2uiEventHandlers) {
      if (
        match.templateRootType &&
        match.templateRootType !== ev.templateRootType
      )
        continue;
      if (match.componentType && match.componentType !== ev.componentType)
        continue;
      if (match.eventType && match.eventType !== ev.eventType) continue;
      if (match.descendantId && match.descendantId !== descendantId) continue;
      // Fire-and-forget the handler — don't await inside the stdin loop.
      Promise.resolve()
        .then(() =>
          state.tabContext.run(handlerTabId, () =>
            handler(ev, {
              setState: tabScopedSetState,
              registerComponent: aethonApi.registerComponent,
              pi: piCtx,
              canvas: tabScopedCanvas,
              shells: aethonApi.shells,
            }),
          ),
        )
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.send({
            type: "notice",
            tabId: handlerTabId,
            message: `a2ui handler: ${message}`,
          });
        });
    }
  }

  function buildPiHandlerCtx(
    state: AethonAgentState,
    deps: DispatcherDeps,
    handlerTab: TabRecord,
    handlerTabId: string,
  ): PiHandlerCtx {
    return {
      async prompt(text: string) {
        if (!text || typeof text !== "string") return;
        if (handlerTab.promptInFlight) {
          deps.send({
            type: "notice",
            tabId: handlerTabId,
            message: "agent busy — handler prompt rejected",
          });
          throw new Error("agent busy — prompt in flight");
        }
        handlerTab.promptInFlight = true;
        handlerTab.agentEndFired = false;
        state.currentAgentTabId = handlerTabId;
        deps.send({
          type: "prompt_started",
          tabId: handlerTabId,
          source: "handler",
        });
        try {
          await state.tabContext.run(handlerTabId, () =>
            handlerTab.session.prompt(text),
          );
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          deps.send({
            type: "notice",
            tabId: handlerTabId,
            message: `handler prompt: ${m}`,
          });
          throw err;
        } finally {
          if (!handlerTab.agentEndFired) {
            handlerTab.promptInFlight = false;
            deps.send({ type: "response_end", tabId: handlerTabId });
          }
          if (state.currentAgentTabId === handlerTabId) {
            state.currentAgentTabId = undefined;
          }
        }
      },
      notify(message: string) {
        if (!message) return;
        deps.send({ type: "notice", tabId: handlerTabId, message });
      },
      get session() {
        const messages = handlerTab.session.messages ?? [];
        return {
          model: handlerTab.session.model
            ? modelKey(handlerTab.session.model)
            : "",
          messages: messages.slice(-50),
        };
      },
      get signal() {
        return (
          handlerTab.session as {
            agent?: { signal?: AbortSignal };
          }
        ).agent?.signal;
      },
    };
  }
}
