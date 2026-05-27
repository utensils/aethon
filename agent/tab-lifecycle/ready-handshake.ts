/**
 * Startup handshake. Builds the `ready` payload the frontend uses to
 * hydrate state: project root, tab list with per-tab cwds, the entire
 * extension surface (components, themes, slash-commands, skills,
 * keybindings, menu items, event routes, layouts, frontend modules),
 * loaded/failed/disabled extension lists, and the cached model list.
 *
 * Pure read of `AethonAgentState` — does not mutate, but does refresh
 * pi slash-commands as a side effect so the payload reflects the
 * current command set.
 */

import type { AethonAgentState } from "../state";
import { defaultModelKey } from "./models";
import { refreshPiSlashCommands } from "./slash-commands";
import type { TabLifecycleDeps } from "./utils";
import { modelKey } from "./utils";

export function emitReady(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
): void {
  const commandSourceTab =
    state.tabs.get("default") ?? state.tabs.values().next().value;
  if (commandSourceTab) {
    refreshPiSlashCommands(state, commandSourceTab.session);
  }
  deps.send({
    type: "ready",
    model: defaultModelKey(state),
    projectRoot: state.projectRoot,
    currentProjectCwd: state.currentProjectCwd,
    userDir: state.userDir,
    models: state.cachedModels,
    tabs: [...state.tabs.values()].map((t) => ({
      id: t.id,
      model: t.session.model ? modelKey(t.session.model) : "",
      cwd: state.tabProjectCwds.get(t.id),
    })),
    extensionComponents: Object.fromEntries(state.extensionComponents),
    extensionState: state.extensionStateTree,
    extensionStateKeys: [...state.extensionStateKeys],
    extensionTabState: Object.fromEntries(state.perTabExtState),
    extensionLayout: state.extensionLayout,
    extensionLayoutPatches: state.pendingLayoutPatches,
    extensionThemes: [...state.extensionThemes.values()],
    extensionSlashCommands: [...state.extensionSlashCommands.values()],
    piSlashCommands: state.piSlashCommands,
    piSkills: state.piSkills,
    extensionKeybindings: [...state.extensionKeybindings.values()],
    extensionMenuItems: [...state.extensionMenuItems.values()],
    extensionEventRoutes: [...state.extensionEventRoutes.values()],
    extensionEventRoutingMode: state.eventRoutingMode,
    extensionLayouts: [...state.extensionLayouts.values()],
    extensionFrontendModules: [...state.extensionFrontendModules.values()].map(
      (m) => ({
        name: m.name,
        code: m.code,
      }),
    ),
    extensionsList: [...state.loadedExtensions.entries()].map(
      ([name, source]) => ({
        name,
        source,
        ...(source === "project-directory"
          ? { projectRoot: state.projectExtensionRoots.get(name) }
          : {}),
      }),
    ),
    failedExtensionsList: [...state.loadFailures.entries()].map(
      ([name, info]) => ({
        name,
        source: info.source,
        error: info.error,
        ...(info.path ? { path: info.path } : {}),
        ...(info.projectRoot ? { projectRoot: info.projectRoot } : {}),
      }),
    ),
    disabledExtensionsList: [...state.disabledExtensions].sort().map((name) => {
      const meta = state.disabledExtensionMeta.get(name);
      if (!meta) return { name };
      return meta.projectRoot
        ? { name, source: meta.source, projectRoot: meta.projectRoot }
        : { name, source: meta.source };
    }),
    discoveredTabs: state.discoveredTabs,
  });
}
