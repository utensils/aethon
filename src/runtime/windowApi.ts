import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { Tab } from "../types/tab";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { A2UISkill } from "../skills/types";
import {
  layoutSlots,
  inspectLayoutSlotCoverage,
  type LayoutCatalogueEntry,
  type SlotCoverageReport,
} from "../skills/default-layout";
import {
  activeProject,
  type ProjectsState,
} from "../projects";
import { registerGrammar as registerHighlightGrammar } from "../utils/highlight";

export interface UseWindowApiContext {
  layout: A2UIPayload;
  bootLayout: A2UIPayload;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  registry: SkillRegistry;
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
}

/**
 * Mounts and maintains `window.aethon` — the runtime API surface that
 * lets agent extensions, slash commands, and the dev console swap
 * chrome at runtime (set/reset layout, register skills/layouts, list
 * tabs/skills/projects, open projects, register syntax highlighting
 * grammars).
 *
 * Also installs the dev-only `window.__AETHON_*` debug hooks used by
 * the aethon-debug skill (state snapshot, registry, setState dispatch).
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
  } = ctx;

  useEffect(() => {
    const api = {
      setLayout,
      resetLayout: () => setLayout(bootLayout),
      getLayout: () => layout,
      registerSkill: (skill: A2UISkill) => {
        registry.register(skill);
        if (skill.layout) setLayout(skill.layout);
      },
      listSkills: () => registry.list().map((s) => s.name),
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
      registerHighlightGrammar: (lang: string, grammar: unknown): boolean => {
        if (typeof lang !== "string" || lang.trim().length === 0) return false;
        if (!grammar || typeof grammar !== "object") return false;
        registerHighlightGrammar(lang.trim(), grammar);
        return true;
      },
    };
    (window as unknown as { aethon: typeof api }).aethon = api;

    if (import.meta.env.DEV) {
      const win = window as unknown as {
        __AETHON_STATE__: () => Record<string, unknown>;
        __AETHON_REGISTRY__: SkillRegistry;
        __AETHON_SET_STATE__: (next: Record<string, unknown>) => void;
      };
      win.__AETHON_STATE__ = () => stateRef.current;
      win.__AETHON_REGISTRY__ = registry;
      win.__AETHON_SET_STATE__ = setState;
    }
    // The api closures intentionally read live state via stateRef /
    // setState callbacks, so a stale reference inside `api` doesn't
    // produce stale data. Adding the function deps would re-build this
    // effect every render and churn window.aethon for no behavioral gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, registry]);
}
