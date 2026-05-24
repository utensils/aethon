import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIPayload, SidebarItem } from "../types/a2ui";
import {
  buildBuiltinSlashCommands,
  type SlashCommand,
} from "../slashCommands";
import { reconcileFrontendModules } from "../skills/extensionFrontendLoader";
import type { SkillRegistry } from "../skills/SkillRegistry";
import {
  builtinLayouts,
  type LayoutCatalogueEntry,
} from "../skills/default-layout";
import { deepMergeState } from "../utils/stateMutation";
import { normalizeRegisteredCombo } from "../utils/keybindings";

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

export type ExtensionSidebarItem = SidebarItem & {
  hint?: string;
};

const CORE_EXTENSION_NAMES = new Set(["default-layout"]);

function normalizeExtensionProjectPath(path: string | undefined | null): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

export function filterExtensionSummariesByProject<
  T extends ExtensionSummary,
>(entries: T[], activeProjectPath: string | null = null): T[] {
  const activePath = normalizeExtensionProjectPath(activeProjectPath);
  return entries.filter((entry) => {
    if (entry.source !== "project-directory") return true;
    const projectRoot = normalizeExtensionProjectPath(entry.projectRoot);
    return (
      activePath.length > 0 &&
      projectRoot.length > 0 &&
      (activePath === projectRoot || activePath.startsWith(`${projectRoot}/`))
    );
  });
}

function extensionSourceLabel(source: string): string {
  switch (source) {
    case "directory":
    case "global-directory":
      return "user";
    case "project-directory":
      return "project";
    case "extension-package":
      return "package";
    default:
      return source;
  }
}

function normalizeDisabledRecord(
  entry: DisabledExtensionRecord | string,
): DisabledExtensionRecord {
  return typeof entry === "string" ? { name: entry } : entry;
}

/** Decide whether a disabled-row entry should appear given the active
 *  project. Project-directory entries are scoped to their projectRoot;
 *  everything else (user directory, npm package, pi-extension, or a
 *  legacy entry with no source) is treated as global. */
export function disabledExtensionMatchesProject(
  record: DisabledExtensionRecord,
  activeProjectPath: string | null,
): boolean {
  if (record.source !== "project-directory") return true;
  const activePath = normalizeExtensionProjectPath(activeProjectPath);
  const projectRoot = normalizeExtensionProjectPath(record.projectRoot);
  return (
    activePath.length > 0 &&
    projectRoot.length > 0 &&
    (activePath === projectRoot || activePath.startsWith(`${projectRoot}/`))
  );
}

export function buildExtensionSidebarItems(
  loaded: ExtensionSummary[],
  failed: ExtensionFailureSummary[],
  disabled: ReadonlyArray<DisabledExtensionRecord | string> = [],
  activeProjectPath: string | null = null,
): ExtensionSidebarItem[] {
  const scopedLoaded = filterExtensionSummariesByProject(
    loaded,
    activeProjectPath,
  );
  const scopedFailed = filterExtensionSummariesByProject(
    failed,
    activeProjectPath,
  );
  const disabledRecords = disabled.map(normalizeDisabledRecord);
  const disabledSet = new Set(disabledRecords.map((d) => d.name));
  const scopedDisabled = disabledRecords.filter((d) =>
    disabledExtensionMatchesProject(d, activeProjectPath),
  );
  // An extension may appear in `loaded` (live this run) but also be
  // marked disabled (toggle landed mid-session, takes effect after
  // restart). Show it in the disabled bucket so the user sees their
  // pending intent, with a hint that a restart is needed to fully
  // unload it.
  return [
    ...scopedLoaded
      .filter((e) => !CORE_EXTENSION_NAMES.has(e.name))
      .filter((e) => !disabledSet.has(e.name))
      .map((e) => ({
        id: `ext:${e.name}`,
        label: e.name,
        hint: extensionSourceLabel(e.source),
        active: true,
      })),
    ...scopedFailed
      .filter((e) => !CORE_EXTENSION_NAMES.has(e.name))
      .filter((e) => !disabledSet.has(e.name))
      .map((e) => ({
        id: `ext-failed:${e.name}`,
        label: e.name,
        hint: `${extensionSourceLabel(e.source)} · failed`,
        active: false,
      })),
    ...scopedDisabled
      .filter((d) => !CORE_EXTENSION_NAMES.has(d.name))
      .map((d) => {
        const stillLoaded = loaded.some((e) => e.name === d.name);
        return {
          id: `ext-disabled:${d.name}`,
          label: d.name,
          hint: stillLoaded ? "disabled · restart" : "disabled",
          active: false,
        };
      }),
  ];
}

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

export function buildHydratedSlashCommands(
  builtins: SlashCommand[],
  extensionCommands: { name: string; description: string; usage?: string }[],
  piCommands: { name: string; description: string; usage?: string }[],
  makeExtensionCommand: (
    command: { name: string; description: string; usage?: string },
  ) => SlashCommand,
): SlashCommand[] {
  const builtinNames = new Set(builtins.map((c) => c.name));
  const dispatched = extensionCommands
    .filter((c) => !builtinNames.has(c.name))
    .map(makeExtensionCommand);
  const reservedNames = new Set([
    ...builtins.map((c) => c.name),
    ...dispatched.map((c) => c.name),
  ]);
  const piPassthroughCommands: SlashCommand[] = piCommands
    .filter((s) => !reservedNames.has(s.name))
    .map((s) => ({
      name: s.name,
      description: s.description,
      usage: s.usage,
      passthroughToAgent: true,
      run: () => {},
    }));
  return [...builtins, ...dispatched, ...piPassthroughCommands];
}

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
 */
export function useExtensionsHydration(
  ctx: UseExtensionsHydrationContext,
): UseExtensionsHydrationActions {
  const {
    setState,
    setLayout,
    stateRef,
    registry,
    appendSystem,
    layout,
  } = ctx;

  const themesRef = useRef<Map<string, ExtensionTheme>>(new Map());
  const layoutCatalogueRef = useRef<LayoutCatalogueEntry[]>([
    ...builtinLayouts,
  ]);
  const extensionEventRoutesRef = useRef<
    { componentId?: string; eventType?: string }[]
  >([]);
  const extensionEventRoutingModeRef =
    useRef<"builtin" | "extension">("builtin");
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

  /** Inject (or replace) the <style> element holding an extension theme's
   *  CSS custom properties. Keyed by id so re-registering replaces the
   *  previous rule rather than stacking. Values written via CSSOM
   *  setProperty (not string interpolation) so a malformed value
   *  containing `;` or `}` can't escape the declaration. */
  function injectThemeStyle(theme: ExtensionTheme) {
    const styleId = `aethon-theme-${theme.id}`;
    let el = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = styleId;
      document.head.appendChild(el);
    }
    const safe =
      window.CSS && window.CSS.escape
        ? window.CSS.escape(theme.id)
        : theme.id.replace(/[^A-Za-z0-9_-]/g, "");
    const sheet = el.sheet;
    if (!sheet) {
      el.textContent = "";
      return;
    }
    while (sheet.cssRules.length > 0) sheet.deleteRule(0);
    sheet.insertRule(`:root[data-theme="${safe}"] {}`);
    const rule = sheet.cssRules[0] as CSSStyleRule;
    rule.style.setProperty("color-scheme", "dark");
    for (const [k, v] of Object.entries(theme.vars)) {
      rule.style.setProperty(k, v);
    }
  }

  /** Apply a fresh themes list — replace the registry, inject CSS for
   *  each, and mirror id/label pairs to /sidebar/themes so the sidebar
   *  updates. Style tags whose ids no longer appear in the list are
   *  removed first so a deleted/disabled extension stops bleeding stale
   *  CSS into the page. */
  function hydrateThemes(list: ExtensionTheme[]) {
    themesRef.current = new Map(list.map((t) => [t.id, t]));
    const keep = new Set(list.map((t) => `aethon-theme-${t.id}`));
    for (const el of document.querySelectorAll('style[id^="aethon-theme-"]')) {
      if (!keep.has(el.id)) el.remove();
    }
    for (const t of list) injectThemeStyle(t);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      const currentTheme =
        document.documentElement.dataset.theme || BUILTIN_THEMES[0]?.id;
      const themes = [
        ...BUILTIN_THEMES,
        ...list.map((t) => ({ id: t.id, label: t.label })),
      ].map((t) => ({ ...t, active: t.id === currentTheme }));
      return {
        ...prev,
        sidebar: { ...sidebar, themes },
      };
    });
  }

  function hydrateExtensions(
    loaded: ExtensionSummary[],
    failed: ExtensionFailureSummary[],
    disabled: ReadonlyArray<DisabledExtensionRecord | string> = [],
    activeProjectPath: string | null = null,
  ) {
    const items = buildExtensionSidebarItems(
      loaded,
      failed,
      disabled,
      activeProjectPath,
    );
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      return { ...prev, sidebar: { ...sidebar, extensions: items } };
    });
  }

  function listThemes(): { id: string; label: string }[] {
    return [
      ...BUILTIN_THEMES,
      ...[...themesRef.current.values()].map((t) => ({
        id: t.id,
        label: t.label,
      })),
    ];
  }

  function summarizeLayoutComponents(payload: A2UIPayload): {
    id: string;
    label: string;
    active: boolean;
  }[] {
    const types = new Set<string>();
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        children?: unknown[];
        components?: unknown[];
      };
      if (typeof n.type === "string") types.add(n.type);
      if (Array.isArray(n.children)) n.children.forEach(walk);
      if (Array.isArray(n.components)) n.components.forEach(walk);
    }
    walk(payload);
    return [...types]
      .sort()
      .map((t) => ({ id: `c-${t}`, label: t, active: true }));
  }

  /** Refresh /sidebar/components whenever the layout changes so any
   *  extension-registered inspector reflects what's actually rendered. */
  useEffect(() => {
    const list = summarizeLayoutComponents(layout);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      return { ...prev, sidebar: { ...sidebar, components: list } };
    });
  }, [layout, setState]);

  /** Layout activation — single path used by both
   *  `window.aethon.activateLayout` and the `/layout` slash command.
   *  Seeds layout state defaults for keys absent from current app state
   *  (live state wins on collisions) and rebuilds /sidebar/layouts. */
  function activateLayoutById(id: string): boolean {
    const entry = layoutCatalogueRef.current.find((l) => l.id === id);
    if (!entry) return false;
    setLayout(entry.payload);
    const seeds = entry.payload.state ?? {};
    const catalogueItems = layoutCatalogueRef.current.map((l) => ({
      id: l.id,
      label: l.id,
      active: l.id === id,
    }));
    setState((prev) => {
      const seeded =
        seeds && Object.keys(seeds).length > 0
          ? deepMergeState(seeds, prev)
          : { ...prev };
      // The new layout's `columns` seed is authoritative — different
      // layouts may have different grid SHAPES, and deepMergeState keeps
      // prev's columns, which would mean a 2-col grid carrying a
      // 3-col-only cell has nowhere to render. So force-take the seed's
      // columns, then patch the leading sidebar token with the user's
      // persisted width so cross-layout resizing feels continuous.
      const seedLayout =
        (seeds.layout as Record<string, unknown> | undefined) ?? {};
      const prevLayout =
        (prev.layout as Record<string, unknown> | undefined) ?? {};
      const seedCols = (seedLayout.columns as string | undefined) ?? "";
      const prevCols = (prevLayout.columns as string | undefined) ?? "";
      let nextCols = seedCols;
      if (seedCols && prevCols) {
        const seedTokens = seedCols.trim().split(/\s+/);
        const prevTokens = prevCols.trim().split(/\s+/);
        if (seedTokens.length > 0 && prevTokens[0]?.endsWith("px")) {
          seedTokens[0] = prevTokens[0];
          nextCols = seedTokens.join(" ");
        }
      }
      const seededLayout =
        (seeded.layout as Record<string, unknown> | undefined) ?? {};
      seeded.layout = nextCols
        ? { ...seededLayout, columns: nextCols }
        : seededLayout;
      const sidebar =
        (seeded.sidebar as Record<string, unknown> | undefined) ?? {};
      seeded.sidebar = { ...sidebar, layouts: catalogueItems };
      return seeded;
    });
    return true;
  }

  /** Surface the slash command list + layout catalogue into layout state
   *  so the chat-input autocomplete can resolve via $ref. Done once on
   *  mount; subsequent updates flow through hydrateSlashCommands /
   *  hydrateExtensionLayouts. */
  useEffect(() => {
    setState((prev) => {
      const sidebar =
        (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const activeLayoutId = (() => {
        const list =
          (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ??
          [];
        return (
          list.find((l) => l.active)?.id ?? layoutCatalogueRef.current[0]?.id
        );
      })();
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeLayoutId,
      }));
      return {
        ...prev,
        slashCommands: slashCommandsRef.current.map((c) => ({
          name: c.name,
          description: c.description,
          usage: c.usage,
          argSource: c.argSource,
        })),
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
    // Mount-only seed — we explicitly don't want to re-run on setState
    // identity churn since this is a layout-prime, not a sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hydrateEventRoutes(
    routes: { componentId?: string; eventType?: string }[],
    mode: "builtin" | "extension" = extensionEventRoutingModeRef.current,
  ) {
    extensionEventRoutesRef.current = routes;
    extensionEventRoutingModeRef.current = mode;
  }

  function hydrateKeybindings(
    list: { combo: string; action: string; description?: string }[],
  ) {
    const next = new Map<
      string,
      { combo: string; action: string; description?: string }
    >();
    for (const b of list) {
      const canonical = normalizeRegisteredCombo(b.combo);
      if (!canonical) continue;
      next.set(canonical, { ...b, combo: canonical });
    }
    extensionKeybindingsRef.current = next;
  }

  function hydrateExtensionLayouts(
    list: {
      id: string;
      name: string;
      description?: string;
      payload: A2UIPayload;
    }[],
  ) {
    const builtinIds = new Set(builtinLayouts.map((l) => l.id));
    const surviving = layoutCatalogueRef.current.filter((l) =>
      builtinIds.has(l.id),
    );
    const incoming = list
      .filter(
        (l) =>
          !builtinIds.has(l.id) && typeof l.id === "string" && l.payload,
      )
      .map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        payload: l.payload,
      }));
    layoutCatalogueRef.current = [...surviving, ...incoming];
    setState((prev) => {
      const sidebar =
        (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const prevLayoutItems =
        (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ??
        [];
      const activeId =
        prevLayoutItems.find((l) => l.active)?.id ??
        layoutCatalogueRef.current[0]?.id;
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeId,
      }));
      return {
        ...prev,
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
  }

  function hydrateFrontendModules(list: { name: string; code: string }[]) {
    const previous = frontendModulesRef.current;
    const { loaded, unregistered } = reconcileFrontendModules(
      previous,
      list,
      registry,
    );
    frontendModulesRef.current = new Map(list.map((m) => [m.name, m.code]));
    for (const m of loaded) {
      if (m.error) {
        appendSystem(`extension frontend module ${m.name}: ${m.error}`);
      }
    }
    if (loaded.length > 0 || unregistered.length > 0) {
      // Bump a counter so any A2UIRenderer subtree using a now-changed
      // component type re-resolves through the SkillRegistry on the
      // next render. The registry itself doesn't trigger React updates;
      // bumping a piece of state owned by App.tsx does.
      setState((prev) => ({
        ...prev,
        extensionModulesGen:
          ((prev.extensionModulesGen as number | undefined) ?? 0) + 1,
      }));
    }
  }

  function hydrateSlashCommands(
    list: { name: string; description: string; usage?: string }[],
    piCommands?: { name: string; description: string; usage?: string }[],
  ) {
    if (piCommands) piCommandsRef.current = piCommands;
    const builtins = buildBuiltinSlashCommands();
    const dispatchedNames = list
      .filter((c) => !new Set(builtins.map((b) => b.name)).has(c.name))
      .map((c) => c.name);
    slashCommandsRef.current = buildHydratedSlashCommands(
      builtins,
      list,
      piCommandsRef.current,
      (c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        run: async (args: string) => {
          await invoke("dispatch_a2ui_event", {
            event: JSON.stringify({
              componentId: `slash-command__tpl__${c.name}`,
              componentType: "slash-command",
              templateRootType: "slash-command",
              eventType: "invoke",
              data: { args },
            }),
            tabId: stateRef.current.activeTabId,
          });
        },
      }),
    );
    extensionSlashNamesRef.current = new Set(dispatchedNames);
    setState((prev) => ({
      ...prev,
      slashCommands: slashCommandsRef.current.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        argSource: c.argSource,
      })),
    }));
  }

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
