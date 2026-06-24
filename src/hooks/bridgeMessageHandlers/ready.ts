import { invoke } from "@tauri-apps/api/core";
import type { A2UIPayload } from "../../types/a2ui";
import { activeProject } from "../../projects";
import type { Tab } from "../../types/tab";
import {
  EMPTY_AUTH_PROFILES,
  type AuthProfilesSnapshot,
} from "../../auth-profiles";
import { layoutPatch } from "../../utils/stateMutation";
import type {
  DisabledExtensionRecord,
  ExtensionFailureSummary,
  ExtensionSummary,
  ExtensionTheme,
} from "../useExtensionsHydration";
import type {
  BridgeMessageHandler,
  DiscoveredSession,
  ModelDescriptor,
} from "./types";
import {
  replayHighlightGrammars,
  type ExtensionHighlightGrammar,
} from "./extensionHighlightGrammars";
import { runReadyEffects } from "./readyEffects";
import { isWorkstationBootLayout, reduceReadyState } from "./readyState";

/** Bridge ready ingestion: parse the bridge snapshot, hydrate extension
 *  registries/layout, reduce ready-owned app state, then run the
 *  restore/reannounce side-effect phase. Called on first boot, webview
 *  reloads, bridge respawns, and explicit boot `report` requests. */
export const handleReady: BridgeMessageHandler = (data, ctx) => {
  const model = (data.model as string) || "";
  const projectRoot =
    typeof data.projectRoot === "string" && data.projectRoot.length > 0
      ? data.projectRoot
      : undefined;
  const userDir =
    typeof data.userDir === "string" && data.userDir.length > 0
      ? data.userDir
      : undefined;
  const currentProjectCwd =
    typeof data.currentProjectCwd === "string" &&
    data.currentProjectCwd.length > 0
      ? data.currentProjectCwd
      : null;
  const priorActiveTabId =
    (ctx.stateRef.current.activeTabId as string | undefined) ?? "default";
  const priorActiveTab = (
    (ctx.stateRef.current.tabs as Tab[] | undefined) ?? []
  ).find((t) => t.id === priorActiveTabId);
  const priorActiveTabCwd =
    priorActiveTab?.kind !== "shell" &&
    typeof priorActiveTab?.cwd === "string" &&
    priorActiveTab.cwd.length > 0
      ? priorActiveTab.cwd
      : null;
  // Cache pi's default model so new tabs created before `ready` fires
  // (or before a session's model initialises) can inherit it immediately
  // instead of showing blank "model ▼".
  if (model && !ctx.piDefaultModelRef.current) {
    ctx.piDefaultModelRef.current = model;
  }
  const fallbackModel = ctx.piDefaultModelRef.current || model;
  if (fallbackModel) {
    // Mirror to state so the header ModelPicker has something to render
    // even when there is no active tab (fresh boot lands on the
    // projects-dashboard, /model is undefined until a tab is opened).
    ctx.setState((prev) => ({
      ...prev,
      piDefaultModel: prev.piDefaultModel || fallbackModel,
    }));
  }
  const models = (data.models as ModelDescriptor[]) ?? [];
  // Hydrate any extension-registered component templates the bridge
  // discovered at boot. setTemplates is wholesale (bridge is the source
  // of truth) so reload-after-restart picks up the same set.
  const extComponents =
    (data.extensionComponents as Record<string, unknown> | undefined) ?? {};
  const extState =
    (data.extensionState as Record<string, unknown> | undefined) ?? {};
  const extLayout = data.extensionLayout as A2UIPayload | undefined;
  const extPatches =
    (data.extensionLayoutPatches as
      | { path: string; value: unknown }[]
      | undefined) ?? [];
  const extThemes =
    (data.extensionThemes as ExtensionTheme[] | undefined) ?? [];
  const extSlash =
    (data.extensionSlashCommands as
      | { name: string; description: string; usage?: string }[]
      | undefined) ?? [];
  const piCommands =
    (data.piSlashCommands as
      | { name: string; description: string; usage?: string }[]
      | undefined) ??
    (data.piSkills as
      | { name: string; description: string; usage?: string }[]
      | undefined) ??
    [];
  const extKeys =
    (data.extensionKeybindings as
      | { combo: string; action: string; description?: string }[]
      | undefined) ?? [];
  const extMenu =
    (data.extensionMenuItems as
      | {
          id: string;
          label: string;
          action: string;
          location: "app" | "tray";
          parent?: string;
        }[]
      | undefined) ?? [];
  const extEventRoutes =
    (data.extensionEventRoutes as
      | { componentId?: string; eventType?: string }[]
      | undefined) ?? [];
  const extEventRoutingMode =
    data.extensionEventRoutingMode === "extension" ? "extension" : "builtin";
  const extLayouts =
    (data.extensionLayouts as
      | {
          id: string;
          name: string;
          description?: string;
          payload: A2UIPayload;
        }[]
      | undefined) ?? [];
  const extFrontendModules =
    (data.extensionFrontendModules as
      | { name: string; code: string }[]
      | undefined) ?? [];
  const extHighlightGrammars =
    (data.extensionHighlightGrammars as
      | ExtensionHighlightGrammar[]
      | undefined) ?? [];
  const extStateKeys = (data.extensionStateKeys as string[] | undefined) ?? [];
  const discTabs =
    (data.discoveredTabs as DiscoveredSession[] | undefined) ?? [];
  const authProfiles =
    (data.authProfiles as AuthProfilesSnapshot | undefined) ??
    EMPTY_AUTH_PROFILES;
  ctx.allDiscoveredSessionsRef.current = discTabs;
  // Hydrate extension themes BEFORE the layout state merge below so
  // /sidebar/themes carries the full list (built-ins + extension) when
  // the merge runs. hydrateThemes also injects the CSS so a saved
  // choice has the rule available before data-theme is read.
  ctx.hydrateThemes(extThemes);
  // Set of known project basenames lets the sidebar's extension
  // filter scope `@<project>/<pkg>` npm packages to that project even
  // though they're installed globally — see
  // `disabledExtensionMatchesProject`.
  const knownProjectBasenames = new Set(
    ctx.projectsRef.current.projects
      .map((p) => p.path.split("/").filter(Boolean).pop() ?? "")
      .filter((b) => b.length > 0),
  );
  ctx.hydrateExtensions(
    (data.extensionsList as ExtensionSummary[] | undefined) ?? [],
    (data.failedExtensionsList as ExtensionFailureSummary[] | undefined) ?? [],
    (data.disabledExtensionsList as
      | ReadonlyArray<DisabledExtensionRecord | string>
      | undefined) ?? [],
    activeProject(ctx.projectsRef.current)?.path ?? null,
    knownProjectBasenames,
  );
  ctx.registry.setTemplates(extComponents);
  // Restore extension-registered slash commands so the picker shows them
  // on first paint (no need to wait for an extension_slash_commands
  // delta after reload). hydrateSlashCommands rewrites the merged
  // catalog (built-ins + extensions), updates the picker state ref, and
  // bumps /slashCommands so the picker re-resolves via $ref.
  ctx.hydrateSlashCommands(extSlash, piCommands);
  ctx.hydrateKeybindings(extKeys);
  ctx.hydrateEventRoutes(extEventRoutes, extEventRoutingMode);
  ctx.hydrateExtensionLayouts(extLayouts);
  ctx.hydrateFrontendModules(extFrontendModules);
  replayHighlightGrammars(extHighlightGrammars);
  // Push the persisted menu list into Tauri so the native menu is
  // correct on first paint after webview reload. Errors are logged but
  // non-fatal — the menu falls back to built-ins-only.
  if (extMenu.length > 0) {
    invoke("set_extension_menu_items", { items: extMenu }).catch(
      (err: unknown) => {
        console.warn("[menu] set_extension_menu_items failed:", err);
      },
    );
  }
  // Surface discovered persistent sessions in the empty-state's
  // recent-sessions list. Filter out tabIds we already have local
  // records for so the same session isn't listed twice (open AND
  // restorable). Format the lastModified into a "10m ago"-style label
  // for the row's right-hand meta.
  const localKnownIds = ctx.knownTabIds();
  const bridgeKnownIds = ctx.knownTabIds(
    (data.tabs as { id: string }[] | undefined) ?? [],
  );
  const scopedDiscTabs = ctx.scopedDiscoveredSessions(discTabs);
  const recentSessions = ctx.recentSessionItems(scopedDiscTabs, localKnownIds);
  if (ctx.projectsLoadedRef.current) {
    ctx.autoRestoreDiscoveredSessions(scopedDiscTabs, bridgeKnownIds);
  }
  // Restore any extension-supplied layout, then replay queued patches.
  // Falls back to the boot layout when none is reported so a removed /
  // disabled extension stops bleeding stale chrome across agent reloads.
  // The layout's own `state` hydrates below alongside extensionState —
  // same semantics as the live `layout_set` path so replay matches.
  const baseLayout: A2UIPayload =
    extLayout &&
    typeof extLayout === "object" &&
    Array.isArray(extLayout.components)
      ? extLayout
      : ctx.bootLayout;
  const shouldNormalizeWorkstationLayout =
    baseLayout === ctx.bootLayout && isWorkstationBootLayout(baseLayout);
  const patchedLayout = extPatches.reduce<A2UIPayload>(
    (acc, p) => layoutPatch(acc, p.path, p.value),
    baseLayout,
  );
  ctx.setLayout(patchedLayout);
  // Snapshot the prune set BEFORE the setState callback so the side
  // effect of updating lastExtensionStateKeysRef can stay outside
  // setState — otherwise concurrent-mode re-runs of the callback would
  // update the ref multiple times and race with the next ready's read.
  // Compute willPrune (= prev set − new set) here and freeze it for the
  // duration of this handler.
  const willPruneKeys: string[] = [];
  for (const stale of ctx.lastExtensionStateKeysRef.current) {
    if (!extStateKeys.includes(stale)) willPruneKeys.push(stale);
  }
  // Update the ref BEFORE calling setState so the next ready (which may
  // arrive in the same React batch) sees the new "previous" set.
  ctx.lastExtensionStateKeysRef.current = new Set(extStateKeys);
  ctx.setState((prev) =>
    reduceReadyState(prev, {
      authProfiles,
      baseLayout,
      bridgeTabs:
        (data.tabs as
          | {
              id: string;
              model: string;
              cwd?: string;
              authProfileId?: string;
              contextUsage?: Record<string, unknown>;
              thinkingLevel?: string;
            }[]
          | undefined) ?? [],
      codexFastMode: data.codexFastMode,
      extState,
      fallbackModel,
      models,
      projectRoot,
      readyModel: model,
      readyThinkingLevel:
        typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
      recentSessions,
      shouldNormalizeWorkstationLayout,
      tabReplay:
        (data.extensionTabState as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {},
      userDir,
      willPruneKeys,
    }),
  );
  runReadyEffects(ctx, {
    currentProjectCwd,
    priorActiveTabCwd,
    priorActiveTabId,
  });
};
