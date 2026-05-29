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
    // Bind the save to the project active *now*, and snapshot the tabs at
    // schedule time. By the time cleanup runs after a project switch,
    // `stateRef` already holds the incoming project's tabs, so the snapshot
    // is the only way to flush the outgoing project's tabs correctly.
    const projectId = projectsRef.current.activeId;
    const snapshotTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const snapshotActive = stateRef.current.activeTabId as string | undefined;
    const timer = window.setTimeout(() => {
      void saveEditorTabsForProject(
        projectId,
        (stateRef.current.tabs as Tab[] | undefined) ?? [],
        stateRef.current.activeTabId as string | undefined,
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      // If the active project changed before the debounce fired, the pending
      // save would be lost (and a later tick would persist the new project's
      // tabs). Flush the outgoing project's snapshot now so its edits
      // survive a switch-then-quit.
      if (projectsRef.current.activeId !== projectId) {
        void saveEditorTabsForProject(projectId, snapshotTabs, snapshotActive);
      }
    };
  }, [tabsSignal, activeTabId, stateRef, projectsRef, projectsLoadedRef]);
}
