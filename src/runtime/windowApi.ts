import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import type { A2UIExtension } from "../extensions/types";
import {
  layoutSlots,
  inspectLayoutSlotCoverage,
  type LayoutCatalogueEntry,
  type SlotCoverageReport,
} from "../extensions/default-layout";
import {
  activeProject,
  type ProjectsState,
} from "../projects";
import { registerGrammar as registerHighlightGrammar } from "../utils/highlight";
// theme-registry, NOT theme: registering a Monaco theme from the boot
// path must not pull the monaco-editor chunk. The registry replays
// registrations when the editor chunk loads.
import {
  registerMonacoTheme as registerMonacoThemeImpl,
  applyMonacoThemeIfLoaded,
} from "../monaco/theme-registry";
// file-viewers directly, NOT the ./editor barrel — the barrel's canvas
// re-exports carry the monaco bootstrap side effect.
import { registerFileViewer as registerFileViewerImpl } from "../extensions/default-layout/editor/file-viewers";
import type * as monaco from "monaco-editor";
import { askUserWithChat, type AskUserInput } from "../questions";

export interface UseWindowApiContext {
  layout: A2UIPayload;
  bootLayout: A2UIPayload;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  registry: ExtensionRegistry;
  layoutCatalogueRef: MutableRefObject<LayoutCatalogueEntry[]>;
  projectsRef: MutableRefObject<ProjectsState>;
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: { restoredSession?: boolean; cwd?: string; scrollToMatch?: string },
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  activateLayoutById: (id: string) => boolean;
  openProjectFromPicker: () => Promise<string | null>;
  openProjectByPath: (path: string, label?: string) => string;
  setActiveProjectById: (id: string) => boolean;
  clearActiveProject: () => void;
  removeProjectById: (id: string) => boolean;
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  persistLocalChatMessage?: (
    msg: ChatMessage,
    tabId: string,
  ) => Promise<boolean>;
}

/**
 * Mounts and maintains `window.aethon` — the runtime API surface that
 * lets agent extensions, slash commands, and the dev console swap
 * chrome at runtime (set/reset layout, register extensions/layouts, list
 * tabs/extensions/projects, open projects, register syntax highlighting
 * grammars).
 *
 * Also installs the dev-only `window.__AETHON_*` debug hooks used by
 * the aethon-debug extension (state snapshot, registry, setState dispatch).
 *
 * The api closures read live state via stateRef / setState callbacks
 * so stale references inside `api` don't produce stale data — the
 * effect's deps are intentionally minimal.
 */
export function useWindowApi(ctx: UseWindowApiContext): void {
  const {
    layout,
    bootLayout,
    setLayout,
    setState,
    stateRef,
    registry,
    layoutCatalogueRef,
    projectsRef,
    newTab,
    closeTab,
    setActiveTab,
    activateLayoutById,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
    appendMessage,
    persistLocalChatMessage,
  } = ctx;

  useEffect(() => {
    const api = {
      setLayout,
      resetLayout: () => setLayout(bootLayout),
      getLayout: () => layout,
      registerExtension: (extension: A2UIExtension) => {
        registry.register(extension);
        if (extension.layout) setLayout(extension.layout);
      },
      listExtensions: () => registry.list().map((s) => s.name),
      newTab,
      closeTab,
      switchTab: setActiveTab,
      listTabs: () =>
        ((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => ({
          id: t.id,
          label: t.label,
          active: t.id === stateRef.current.activeTabId,
        })),
      listLayouts: (): LayoutCatalogueEntry[] =>
        layoutCatalogueRef.current.slice(),
      activateLayout: activateLayoutById,
      registerLayout: (entry: LayoutCatalogueEntry): boolean => {
        if (!entry || typeof entry.id !== "string" || !entry.payload) return false;
        const idx = layoutCatalogueRef.current.findIndex(
          (l) => l.id === entry.id,
        );
        if (idx >= 0) {
          layoutCatalogueRef.current[idx] = entry;
        } else {
          layoutCatalogueRef.current.push(entry);
        }
        setState((prev) => ({
          ...prev,
          layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
            id: l.id,
            label: l.name,
            description: l.description,
          })),
        }));
        return true;
      },
      layoutSlots,
      inspectLayoutSlotCoverage: (
        payload?: A2UIPayload,
      ): SlotCoverageReport =>
        inspectLayoutSlotCoverage(payload ?? layout),
      pickProject: openProjectFromPicker,
      openProject: (path: string, label?: string) =>
        openProjectByPath(path, label),
      setActiveProject: setActiveProjectById,
      clearProject: clearActiveProject,
      removeProject: removeProjectById,
      listProjects: () => projectsRef.current.projects.slice(),
      activeProject: () => activeProject(projectsRef.current),
      askUser: (input: AskUserInput) => {
        const tabId =
          (stateRef.current.activeTabId as string | undefined) ?? "default";
        return askUserWithChat({
          input,
          tabId,
          appendMessage,
          persistLocalChatMessage,
        });
      },
      registerHighlightGrammar: (lang: string, grammar: unknown): boolean => {
        if (typeof lang !== "string" || lang.trim().length === 0) return false;
        if (!grammar || typeof grammar !== "object") return false;
        registerHighlightGrammar(lang.trim(), grammar);
        return true;
      },
      /** Register a custom file viewer that replaces Monaco for files
       *  whose extension matches `extensions[]`. The named
       *  `componentType` must be registered separately via
       *  `registerComponent` and receives `{ filePath, projectPath }`
       *  props. Returns false on a malformed argument so the caller
       *  can surface a warning. */
      registerFileViewer: (entry: {
        extensions: string[];
        componentType: string;
      }): boolean => {
        if (!entry || !Array.isArray(entry.extensions)) return false;
        if (typeof entry.componentType !== "string" || !entry.componentType.trim()) {
          return false;
        }
        registerFileViewerImpl(entry);
        return true;
      },
      /** Replace (or register) the Monaco editor theme for an Aethon
       *  theme id. `id` matches a CSS `data-theme="…"` value (e.g.
       *  "ember", "paper"); `data` is a Monaco `IStandaloneThemeData`
       *  with chrome colors + optional token rules. Re-applies
       *  immediately if `id` is the active theme. Returns false on a
       *  malformed argument so the caller can surface a warning. */
      registerMonacoTheme: (
        id: string,
        data: monaco.editor.IStandaloneThemeData,
      ): boolean => {
        if (typeof id !== "string" || id.trim().length === 0) return false;
        if (!data || typeof data !== "object") return false;
        registerMonacoThemeImpl(id.trim(), data);
        const active =
          (stateRef.current as { sidebar?: { themes?: { id: string; active?: boolean }[] } })
            .sidebar?.themes?.find((t) => t.active)?.id ??
          document.documentElement.dataset.theme ??
          "";
        if (active === id.trim()) {
          applyMonacoThemeIfLoaded(active);
        }
        return true;
      },
    };
    (window as unknown as { aethon: typeof api }).aethon = api;

    if (import.meta.env.DEV) {
      const win = window as unknown as {
        __AETHON_STATE__: () => Record<string, unknown>;
        __AETHON_EXTENSION_REGISTRY__: ExtensionRegistry;
        __AETHON_SET_STATE__: (next: Record<string, unknown>) => void;
      };
      win.__AETHON_STATE__ = () => stateRef.current;
      win.__AETHON_EXTENSION_REGISTRY__ = registry;
      win.__AETHON_SET_STATE__ = setState;
    }
    // The api closures intentionally read live state via stateRef /
    // setState callbacks, so a stale reference inside `api` doesn't
    // produce stale data. Adding the function deps would re-build this
    // effect every render and churn window.aethon for no behavioral gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, registry]);
}
