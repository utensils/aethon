import { useEffect, type MutableRefObject } from "react";
import type { ProjectsState } from "../projects";
import type { Tab } from "../types/tab";
import { saveEditorTabsForProject } from "../editorTabs";

export interface UsePersistEditorTabsContext {
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  /** Gate: don't persist before projects (and the editor-tab store) have
   *  loaded at boot, or we'd write a partial set. */
  projectsLoadedRef: MutableRefObject<boolean>;
  /** Reactive trigger — pass `state.tabs`. */
  tabsSignal: unknown;
  /** Reactive trigger — pass `state.activeTabId`. */
  activeTabId: unknown;
}

const DEBOUNCE_MS = 600;

/**
 * Persist the active project's open editor tabs to disk (debounced) so
 * they restore on the next launch. Reads the live tabs/active id from
 * `stateRef` at flush time; the `tabsSignal` / `activeTabId` props are the
 * reactive triggers that schedule a save. `saveEditorTabsForProject`
 * itself no-ops until the boot load has run, so an early tick can't drop
 * other projects' remembered tabs.
 */
export function usePersistEditorTabs(ctx: UsePersistEditorTabsContext): void {
  const { stateRef, projectsRef, projectsLoadedRef, tabsSignal, activeTabId } =
    ctx;
  useEffect(() => {
    if (!projectsLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveEditorTabsForProject(
        projectsRef.current.activeId,
        (stateRef.current.tabs as Tab[] | undefined) ?? [],
        stateRef.current.activeTabId as string | undefined,
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [tabsSignal, activeTabId, stateRef, projectsRef, projectsLoadedRef]);
}
