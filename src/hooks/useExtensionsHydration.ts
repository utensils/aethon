import { useRef } from "react";
import { buildBuiltinSlashCommands, type SlashCommand } from "../slashCommands";
import {
  builtinLayouts,
  type LayoutCatalogueEntry,
} from "../skills/default-layout";
import {
  type ExtensionTheme,
  type UseExtensionsHydrationActions,
  type UseExtensionsHydrationContext,
} from "./extensionsHydration/types";
import { useHydrateExtensions } from "./extensionsHydration/sidebarRows";
import {
  useThemeActions,
  injectThemeStyle,
} from "./extensionsHydration/themes";
import {
  useLayoutActions,
  summarizeLayoutComponents,
} from "./extensionsHydration/layouts";
import { useHydrateKeybindings } from "./extensionsHydration/keybindings";
import { useHydrateEventRoutes } from "./extensionsHydration/eventRoutes";
import { useHydrateFrontendModules } from "./extensionsHydration/frontendModules";
import { useHydrateSlashCommands } from "./extensionsHydration/slashCommands";

export {
  BUILTIN_THEMES,
  type DisabledExtensionRecord,
  type ExtensionFailureSummary,
  type ExtensionKind,
  type ExtensionSidebarItem,
  type ExtensionSummary,
  type ExtensionTheme,
  type UseExtensionsHydrationActions,
  type UseExtensionsHydrationContext,
} from "./extensionsHydration/types";
export {
  classifyExtensionSource,
  disabledExtensionMatchesProject,
  filterExtensionSummariesByProject,
} from "./extensionsHydration/classification";
export { buildExtensionSidebarItems } from "./extensionsHydration/sidebarRows";
export { buildHydratedSlashCommands } from "./extensionsHydration/slashCommands";

/**
 * Mirrors the bridge's "what does this agent ship?" snapshot into app
 * state: themes, extensions, keybindings, event routes, layouts,
 * frontend modules, slash commands. Each `hydrate*` is a wholesale
 * replacement (every delta from the bridge replaces the prior set) —
 * a deleted/disabled extension's contributions vanish from the next
 * render.
 *
 * Owns the JSON-Pointer pruning ledger (lastExtensionStateKeysRef)
 * that lets the bridge merge sweep clear stale extension state slices.
 *
 * Layout activation lives here too because activateLayoutById reads
 * the catalogue and writes /sidebar/layouts through the same surface.
 *
 * This file is the facade. The actual implementation lives under
 * `./extensionsHydration/`:
 *
 * - `types`           — all exported types + BUILTIN_THEMES
 * - `classification`  — project/user scope helpers and filters
 * - `sidebarRows`     — buildExtensionSidebarItems + useHydrateExtensions
 * - `themes`          — injectThemeStyle, useThemeActions
 * - `layouts`         — summarizeLayoutComponents, useLayoutActions
 *                       (activateLayoutById + hydrateExtensionLayouts +
 *                       the two effects: component sync + mount-time seed)
 * - `keybindings`     — useHydrateKeybindings
 * - `eventRoutes`     — useHydrateEventRoutes
 * - `frontendModules` — useHydrateFrontendModules
 * - `slashCommands`   — buildHydratedSlashCommands + useHydrateSlashCommands
 */
export function useExtensionsHydration(
  ctx: UseExtensionsHydrationContext,
): UseExtensionsHydrationActions {
  const { setState, setLayout, stateRef, registry, appendSystem, layout } = ctx;

  const themesRef = useRef<Map<string, ExtensionTheme>>(new Map());
  const layoutCatalogueRef = useRef<LayoutCatalogueEntry[]>([
    ...builtinLayouts,
  ]);
  const extensionEventRoutesRef = useRef<
    { componentId?: string; eventType?: string }[]
  >([]);
  const extensionEventRoutingModeRef = useRef<"builtin" | "extension">(
    "builtin",
  );
  const extensionKeybindingsRef = useRef<
    Map<string, { combo: string; action: string; description?: string }>
  >(new Map());
  const frontendModulesRef = useRef<Map<string, string>>(new Map());
  const slashCommandsRef = useRef<SlashCommand[]>(buildBuiltinSlashCommands());
  const piCommandsRef = useRef<
    { name: string; description: string; usage?: string }[]
  >([]);
  const extensionSlashNamesRef = useRef<Set<string>>(new Set());
  const lastExtensionStateKeysRef = useRef<Set<string>>(new Set());

  const { hydrateThemes, listThemes } = useThemeActions({
    setState,
    themesRef,
  });

  const hydrateExtensions = useHydrateExtensions({ setState });

  const { activateLayoutById, hydrateExtensionLayouts } = useLayoutActions({
    setState,
    setLayout,
    layoutCatalogueRef,
    slashCommandsRef,
    layout,
  });

  const hydrateKeybindings = useHydrateKeybindings({
    extensionKeybindingsRef,
  });

  const hydrateEventRoutes = useHydrateEventRoutes({
    extensionEventRoutesRef,
    extensionEventRoutingModeRef,
  });

  const hydrateFrontendModules = useHydrateFrontendModules({
    setState,
    frontendModulesRef,
    registry,
    appendSystem,
  });

  const hydrateSlashCommands = useHydrateSlashCommands({
    setState,
    stateRef,
    slashCommandsRef,
    piCommandsRef,
    extensionSlashNamesRef,
  });

  return {
    themesRef,
    layoutCatalogueRef,
    extensionEventRoutesRef,
    extensionEventRoutingModeRef,
    extensionKeybindingsRef,
    frontendModulesRef,
    slashCommandsRef,
    extensionSlashNamesRef,
    lastExtensionStateKeysRef,
    injectThemeStyle,
    hydrateThemes,
    hydrateExtensions,
    hydrateEventRoutes,
    hydrateKeybindings,
    hydrateExtensionLayouts,
    hydrateFrontendModules,
    hydrateSlashCommands,
    listThemes,
    summarizeLayoutComponents,
    activateLayoutById,
  };
}
