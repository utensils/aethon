import type {
  AethonAgentState,
  AethonExtensionApi,
  ProjectBaselineSnapshot,
} from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { emitGlobalReady } from "./dispatcherTypes";
import { loadProjectAethonExtensions } from "./extension-loader";
import { patchLayoutTree } from "./layout-manager";
import { logger } from "./logger";
import { dismissNotification, notify } from "./notifications";

export function projectDisplayName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return cwd;
  return trimmed.split(/[\\/]+/).pop() || cwd;
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
    highlightGrammars: new Map(state.extensionHighlightGrammars),
    eventRoutes: new Map(state.extensionEventRoutes),
    eventRoutingMode: state.eventRoutingMode,
    eventHandlerCount: state.a2uiEventHandlers.length,
    handlerDedupeKeys: [...state.registeredHandlerKeys],
    stateTree: JSON.parse(JSON.stringify(state.extensionStateTree)) as Record<
      string,
      unknown
    >,
    stateKeys: [...state.extensionStateKeys],
    frontendModules: new Map(state.extensionFrontendModules),
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
    if (source === "project-directory") {
      state.loadedExtensions.delete(name);
      state.projectExtensionRoots.delete(name);
    }
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
  state.extensionStateKeys.clear();
  for (const k of state.projectBaseline.stateKeys) {
    state.extensionStateKeys.add(k);
  }
  state.extensionFrontendModules.clear();
  for (const [k, v] of state.projectBaseline.frontendModules) {
    state.extensionFrontendModules.set(k, v);
  }
  state.extensionHighlightGrammars.clear();
  for (const [k, v] of state.projectBaseline.highlightGrammars) {
    state.extensionHighlightGrammars.set(k, v);
  }
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
  deps.send({
    type: "extension_frontend_modules",
    modules: [...state.extensionFrontendModules.values()].map((m) => ({
      name: m.name,
      code: m.code,
    })),
  });
  deps.send({
    type: "extension_highlight_grammars",
    grammars: [...state.extensionHighlightGrammars.values()],
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

export async function handleSetProject(
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
      emitGlobalReady(state, deps);
    }
    return;
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    deps.send({
      type: "error",
      message: "set_project: cwd must be string|null",
    });
    return;
  }
  state.tabProjectCwds.set(tabId, cwd);
  const projectChanged = cwd !== state.currentProjectCwd;
  const t0 = projectChanged ? Date.now() : 0;
  if (projectChanged) {
    unloadProjectExtensions(state, deps);
    logger
      .scope("project-switch")
      .debug(`set_project unload took ${Date.now() - t0}ms (cwd=${cwd})`);
  }
  const projectName = projectDisplayName(cwd);
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
      .debug(
        `set_project load took ${Date.now() - tLoad}ms (loaded=${result.loaded} failed=${result.failed} prunedDisabled=${result.prunedDisabled})`,
      );
  }
  state.currentProjectCwd = cwd;
  if (
    result.loaded > 0 ||
    result.failed > 0 ||
    result.prunedDisabled > 0 ||
    projectChanged
  ) {
    const tReload = Date.now();
    await state.resourceLoader.reload();
    if (projectChanged) {
      logger
        .scope("project-switch")
        .debug(
          `set_project resourceLoader.reload took ${Date.now() - tReload}ms`,
        );
    }
    deps.scheduleStateFileWrite();
    emitGlobalReady(state, deps);
    if (projectChanged) {
      // Single info summary per real project switch (the per-phase timings
      // above are debug) — keeps the signal without ~4 info lines per switch,
      // which dominated logs during worktree-heavy sessions (#159).
      logger
        .scope("project-switch")
        .info(
          `set_project total ${Date.now() - t0}ms (cwd=${cwd}, loaded=${result.loaded} failed=${result.failed})`,
        );
    }
  }
}
