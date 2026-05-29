import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { makeEmptyTab, type EditorMeta, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { languageFromPath } from "../../monaco/language-detection";
import { TAB_MIRROR_KEYS } from "./constants";
import { editorLabelForPath } from "./helpers";

export interface EditorTabDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  /** mutations.setActiveTab — focuses the existing tab when the user
   *  re-opens a file that's already mounted. */
  setActiveTab: (tabId: string) => void;
  /** mutations.updateTab — drives `updateEditorMeta` so dirty/cursor
   *  patches flow through the same mirror path as other writes. */
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

export interface EditorTabActions {
  newEditorTab: (
    filePath: string,
    opts?: { rootPath?: string; diff?: boolean },
  ) => void;
  updateEditorMeta: (tabId: string, patch: Partial<EditorMeta>) => void;
  toggleEditorPreview: () => void;
  renameEditorTabsForPath: (from: string, to: string, kind: string) => void;
}

/** Editor-tab creation + edits. `closeEditorTabsForPath` lives next
 *  to the close family in `closeTab.ts` because it routes through
 *  `closeTab` to honor the dirty-buffer confirm prompt. */
export function useEditorTabActions(deps: EditorTabDeps): EditorTabActions {
  const { setState, stateRef, projectsRef, setActiveTab, updateTab } = deps;

  /** Open (or focus) an editor tab for the supplied absolute path. If a
   *  tab for the same path already exists in the current project bucket,
   *  switch to it instead of creating a duplicate. */
  function newEditorTab(
    filePath: string,
    opts: { rootPath?: string; diff?: boolean } = {},
  ): void {
    if (!filePath) return;
    const rootPath = opts.rootPath;
    const diff = opts.diff === true;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    // A diff tab and an editable tab for the same path coexist — match on
    // the diff flag too so "open changes" doesn't just focus the editor.
    const existing = tabs.find(
      (t) =>
        t.kind === "editor" &&
        t.editor?.filePath === filePath &&
        (t.editor.rootPath ?? "") === (rootPath ?? "") &&
        !!t.editor.diff === diff,
    );
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const id = crypto.randomUUID();
    const projectId = projectsRef.current.activeId;
    const language = languageFromPath(filePath);
    const baseLabel = editorLabelForPath(filePath);
    const tab: Tab = {
      ...makeEmptyTab(
        id,
        diff ? `${baseLabel} (diff)` : baseLabel,
        projectId,
        "editor",
      ),
      editor: {
        filePath,
        ...(rootPath ? { rootPath } : {}),
        language,
        isDirty: false,
        ...(diff ? { diff: true } : {}),
      },
    };
    setState((prev) => {
      const list = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      list.push(tab);
      const tabRec = tab as unknown as Record<string, unknown>;
      const result: Record<string, unknown> = {
        ...prev,
        tabs: list,
        activeTabId: id,
        hasTabs: true,
        empty: false,
      };
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = tabRec[key as string];
      }
      return result;
    });
  }

  /** Patch the active editor tab's metadata (dirty flag, cursor). Cheap
   *  no-op if the tab is missing or not an editor tab. */
  function updateEditorMeta(tabId: string, patch: Partial<EditorMeta>): void {
    updateTab(tabId, (t) => {
      if (t.kind !== "editor" || !t.editor) return t;
      const merged = { ...t.editor, ...patch };
      // Skip the setState if nothing meaningful changed — guards against
      // re-render storms from Monaco's cursorPosition events on every key.
      // NOTE: every field a caller can patch must be compared here, or the
      // guard silently swallows the change. `previewMode`/`previewRefreshKey`
      // are part of this contract — omitting them once broke Cmd+Shift+V.
      const samePath = merged.filePath === t.editor.filePath;
      const sameLang = merged.language === t.editor.language;
      const sameDirty = merged.isDirty === t.editor.isDirty;
      const sameLine = merged.cursorLine === t.editor.cursorLine;
      const sameCol = merged.cursorColumn === t.editor.cursorColumn;
      const samePreview = merged.previewMode === t.editor.previewMode;
      const sameRefresh =
        merged.previewRefreshKey === t.editor.previewRefreshKey;
      if (
        samePath &&
        sameLang &&
        sameDirty &&
        sameLine &&
        sameCol &&
        samePreview &&
        sameRefresh
      )
        return t;
      return { ...t, editor: merged };
    });
  }

  /** Toggle the active editor tab's markdown preview mode. No-op when
   *  the active tab isn't an editor tab or isn't a markdown file. */
  function toggleEditorPreview(): void {
    const activeId = stateRef.current.activeTabId as string | undefined;
    if (!activeId) return;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.kind !== "editor" || !tab.editor) return;
    if (tab.editor.language !== "markdown") return;
    updateEditorMeta(activeId, {
      previewMode: !tab.editor.previewMode,
      previewRefreshKey: (tab.editor.previewRefreshKey ?? 0) + 1,
    });
  }

  /** Reconcile open editor tabs after an on-disk rename. For files,
   *  match the exact path and rewrite filePath + label. For folders,
   *  rewrite any tab whose path is rooted at the old folder. Imported
   *  by the file-tree's rename context-menu action. */
  function renameEditorTabsForPath(
    from: string,
    to: string,
    kind: string,
  ): void {
    if (!from || !to || from === to) return;
    const prefix = `${from.replace(/\/+$/, "")}/`;
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      let changed = false;
      const next = tabs.map((tab) => {
        if (tab.kind !== "editor" || !tab.editor) return tab;
        const current = tab.editor.filePath;
        let nextPath: string | null = null;
        if (kind === "dir") {
          if (current.startsWith(prefix)) {
            nextPath = `${to.replace(/\/+$/, "")}/${current.slice(prefix.length)}`;
          } else if (current === from) {
            nextPath = to;
          }
        } else if (current === from) {
          nextPath = to;
        }
        if (!nextPath) return tab;
        changed = true;
        // Recompute the tab label too — Cmd+P/file-tree both expect the
        // basename to track the path. Language id intentionally stays
        // put since Shiki keeps grammars by file extension, which is
        // usually what changed during a rename.
        const renamed: Tab = {
          ...tab,
          label: editorLabelForPath(nextPath),
          editor: {
            ...tab.editor,
            filePath: nextPath,
            language: languageFromPath(nextPath),
          },
        };
        return renamed;
      });
      if (!changed) return prev;
      const result: Record<string, unknown> = { ...prev, tabs: next };
      // Mirror the active tab's updated editor field into the root
      // state so Monaco's EditorCanvas (which reads tabs via $ref) sees
      // the new path on its next render.
      const activeId = prev.activeTabId as string | undefined;
      if (activeId) {
        const active = next.find((t) => t.id === activeId);
        if (active) {
          const rec = active as unknown as Record<string, unknown>;
          for (const key of TAB_MIRROR_KEYS) {
            result[key as string] = rec[key as string];
          }
        }
      }
      return result;
    });
  }

  return {
    newEditorTab,
    updateEditorMeta,
    toggleEditorPreview,
    renameEditorTabsForPath,
  };
}
