import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { A2UIPayload, SidebarItem } from "../../types/a2ui";
import type { SkillRegistry } from "../../skills/SkillRegistry";
import type { LayoutCatalogueEntry } from "../../skills/default-layout";
import type { SlashCommand } from "../../slashCommands";

export interface ExtensionTheme {
  id: string;
  label: string;
  vars: Record<string, string>;
}

export interface ExtensionSummary {
  name: string;
  source: string;
  projectRoot?: string;
}

export interface ExtensionFailureSummary extends ExtensionSummary {
  error?: string;
}

/** Disabled-list entry shape after the v0.3 schema upgrade. The bridge
 *  now ships source/projectRoot when known so the sidebar can hide
 *  project-directory disabled rows when a different project is active.
 *  Entries persisted under the old shape arrive here as bare names with
 *  no metadata; those are treated as global and always shown. */
export interface DisabledExtensionRecord {
  name: string;
  source?: string;
  projectRoot?: string;
}

/** User-visible scope buckets for the sidebar grouping. Two buckets,
 *  because the meaningful distinction is "is this scoped to the
 *  project I'm working on right now?" — packaged npm extensions can
 *  belong to either group depending on whether their scope matches the
 *  active project (e.g. `@mold/image-gallery-ui` is project-scoped
 *  under the `mold` project, but `@brink/current-context-widget` is
 *  user-level). See `classifyExtensionSource` for the mapping. */
export type ExtensionKind = "project" | "user";

export type ExtensionSidebarItem = SidebarItem & {
  hint?: string;
  /** Origin bucket. Carried alongside the item so the sidebar can
   *  split the auto-injected EXTENSIONS section into per-origin
   *  sub-sections without re-deriving the source from the id prefix
   *  on every render. */
  kind?: ExtensionKind;
};

/** Built-in themes always available. CSS for these lives in src/styles/themes.css —
 *  we don't inject a <style> tag for them. */
export const BUILTIN_THEMES: { id: string; label: string }[] = [
  { id: "ember", label: "Ember — warm dark" },
  { id: "paper", label: "Paper — cream light" },
  { id: "aether", label: "Æther — signature" },
  { id: "brink", label: "Brink — Ristretto warm chrome with gold accent" },
];

export interface UseExtensionsHydrationContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  registry: SkillRegistry;
  appendSystem: (text: string) => void;
  /** Live ref to the active layout, watched by the /sidebar/components
   *  effect that re-walks the tree on every change. */
  layout: A2UIPayload;
}

export interface UseExtensionsHydrationActions {
  themesRef: MutableRefObject<Map<string, ExtensionTheme>>;
  layoutCatalogueRef: MutableRefObject<LayoutCatalogueEntry[]>;
  extensionEventRoutesRef: MutableRefObject<
    { componentId?: string; eventType?: string }[]
  >;
  extensionEventRoutingModeRef: MutableRefObject<"builtin" | "extension">;
  extensionKeybindingsRef: MutableRefObject<
    Map<string, { combo: string; action: string; description?: string }>
  >;
  frontendModulesRef: MutableRefObject<Map<string, string>>;
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  extensionSlashNamesRef: MutableRefObject<Set<string>>;
  lastExtensionStateKeysRef: MutableRefObject<Set<string>>;

  injectThemeStyle: (theme: ExtensionTheme) => void;
  hydrateThemes: (list: ExtensionTheme[]) => void;
  hydrateExtensions: (
    loaded: ExtensionSummary[],
    failed: ExtensionFailureSummary[],
    disabled?: ReadonlyArray<DisabledExtensionRecord | string>,
    activeProjectPath?: string | null,
    knownProjectBasenames?: ReadonlySet<string>,
  ) => void;
  hydrateEventRoutes: (
    routes: { componentId?: string; eventType?: string }[],
    mode?: "builtin" | "extension",
  ) => void;
  hydrateKeybindings: (
    list: { combo: string; action: string; description?: string }[],
  ) => void;
  hydrateExtensionLayouts: (
    list: {
      id: string;
      name: string;
      description?: string;
      payload: A2UIPayload;
    }[],
  ) => void;
  hydrateFrontendModules: (list: { name: string; code: string }[]) => void;
  hydrateSlashCommands: (
    list: { name: string; description: string; usage?: string }[],
    piCommands?: { name: string; description: string; usage?: string }[],
  ) => void;
  listThemes: () => { id: string; label: string }[];
  summarizeLayoutComponents: (
    payload: A2UIPayload,
  ) => { id: string; label: string; active: boolean }[];
  activateLayoutById: (id: string) => boolean;
}
