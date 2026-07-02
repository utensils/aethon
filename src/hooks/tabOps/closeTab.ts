import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  OVERVIEW_TAB_ID,
  type EditorDiffSnapshot,
  type ClosedTabEntry,
  type Tab,
} from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { disposeEditorBuffer } from "../../monaco/editor-buffers";
import { discardDeferredTabOpen } from "../bridgeMessageHandlers/readyEffects";
import { recomputeModelPicker } from "../../utils/modelPicker";
import { focusTerminalPanelSoon } from "../../utils/focus";
import { CLOSED_TAB_STACK_MAX, TAB_MIRROR_KEYS } from "./constants";
import { recentSessionItemFromClosedTab } from "./helpers";
import { SESSION_UI_SNAPSHOT_FLUSH_EVENT } from "../../state/sessionUiSnapshot";
import { projectScopeBucketKey } from "../projectOps/tabBuckets";
import type { TabBucket } from "../projectOps/types";
import { remoteHostInvoke } from "../../services/remote";
import { isRemoteHostId } from "./helpers";

export interface CloseTabDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  promptCloseShellTabConfirmation: (tabLabel: string) => Promise<boolean>;
  shellPromptBeforeCloseRef: MutableRefObject<boolean>;
  /** True iff the shell currently has a foreground job other than the
   *  shell itself — i.e. the user fired off a command and hasn't been
   *  returned to a prompt. Used to skip the close-confirmation for idle
   *  shells where the only thing that gets killed is the bash/zsh
   *  sitting on a direnv/nix-shell env. Optional: when omitted, the
   *  close path assumes busy (current behaviour). Reject = assume busy. */
  isShellBusy?: (tabId: string) => Promise<boolean>;
  dispatchTerminalReplay: (buffer: string) => void;
  closedTabsRef: MutableRefObject<ClosedTabEntry[]>;
  tabBucketsRef?: MutableRefObject<Map<string, TabBucket>>;
  /** Bucket switching — the reopen flow needs to land closed tabs back
   *  in their original project bucket, even when the user is currently
   *  in a different one. */
  clearActiveProject: () => void;
  setActiveProjectById: (id: string) => boolean;
  /** New-tab factories — the reopen flow calls back into the per-kind
   *  creators rather than re-implementing them here. */
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: { restoredSession?: boolean; cwd?: string },
  ) => void;
  newShellTab: (options?: {
    command?: string;
    args?: string[];
    cwd?: string;
  }) => void;
  newEditorTab: (
    filePath: string,
    opts?: {
      rootPath?: string;
      diff?: boolean;
      diffSnapshot?: EditorDiffSnapshot;
    },
  ) => void;
}

export interface CloseTabActions {
  pushClosedTab: (tab: Tab) => void;
  reopenLastClosedTab: () => void;
  closeTab: (tabId: string) => void;
  closeTabNow: (tabId: string) => void;
  closeEditorTabsForPath: (path: string, kind: string) => void;
}

function preferredBucketActiveTabId(
  tabs: Tab[],
  currentActive: string | undefined,
): string | undefined {
  if (currentActive && tabs.some((tab) => tab.id === currentActive)) {
    return currentActive;
  }
  return (
    tabs.find((tab) => tab.kind === "agent" || tab.kind === "editor")?.id ??
    tabs[0]?.id
  );
}

function pruneTabFromBucket(
  bucket: TabBucket | undefined,
  tabId: string,
  nextActiveTabId: string | undefined,
): TabBucket | undefined {
  if (!bucket) return undefined;
  const tabs = bucket.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === bucket.tabs.length) return bucket;
  if (tabs.length === 0) return undefined;
  return {
    tabs,
    activeTabId: preferredBucketActiveTabId(tabs, nextActiveTabId),
  };
}

/** Close + reopen family. Owns the closed-tab undo stack, the
 *  dirty-buffer / running-shell confirm prompts, the bridge
 *  `tab_close` / `shell_close` teardown, and the Monaco buffer
 *  disposal for closed editor tabs.
 *
 *  `closeEditorTabsForPath` lives here (rather than in
 *  `editorTab.ts`) because it routes through `closeTab` to honor the
 *  dirty-buffer confirm prompt — a folder delete with unsaved edits
 *  inside it can't silently destroy the in-memory buffer. */
export function useCloseTabActions(deps: CloseTabDeps): CloseTabActions {
  const {
    setState,
    stateRef,
    projectsRef,
    promptCloseShellTabConfirmation,
    shellPromptBeforeCloseRef,
    isShellBusy,
    dispatchTerminalReplay,
    closedTabsRef,
    tabBucketsRef,
    clearActiveProject,
    setActiveProjectById,
    newTab,
    newShellTab,
    newEditorTab,
  } = deps;

  function pushClosedTab(tab: Tab): void {
    const entry: ClosedTabEntry = {
      id: tab.id,
      kind: tab.kind,
      label: tab.label,
      projectId: tab.projectId,
      ...(tab.kind === "shell" && tab.shell
        ? {
            cwd: tab.shell.cwd,
            command: tab.shell.command,
            args: tab.shell.args,
          }
        : {}),
      ...(tab.kind === "agent" && tab.cwd ? { cwd: tab.cwd } : {}),
      ...(tab.kind === "editor" && tab.editor
        ? {
            filePath: tab.editor.filePath,
            ...(tab.editor.rootPath ? { rootPath: tab.editor.rootPath } : {}),
            ...(tab.editor.diff ? { diff: true } : {}),
            ...(tab.editor.diffSnapshot
              ? { diffSnapshot: tab.editor.diffSnapshot }
              : {}),
          }
        : {}),
    };
    closedTabsRef.current.push(entry);
    if (closedTabsRef.current.length > CLOSED_TAB_STACK_MAX) {
      closedTabsRef.current.splice(
        0,
        closedTabsRef.current.length - CLOSED_TAB_STACK_MAX,
      );
    }
  }

  /** Reopen the most-recently-closed tab. Agent tabs reopen with the
   *  *original* tabId — that's the cue for the bridge's
   *  SessionManager.continueRecent to pick up the persisted JSONL session
   *  under `~/.aethon/sessions/<tabId>/`. Shell tabs spawn a fresh PTY
   *  at the original cwd. No-op on empty stack. */
  function reopenLastClosedTab(): void {
    const entry = closedTabsRef.current.pop();
    if (!entry) return;
    // If the closed tab belongs to a different project bucket than
    // the active one, switch to that bucket first so the new tab
    // lands in its original project's tab list.
    const activeId = projectsRef.current.activeId;
    if (entry.projectId !== activeId) {
      if (entry.projectId === null) {
        clearActiveProject();
      } else {
        setActiveProjectById(entry.projectId);
      }
    }
    if (entry.kind === "shell") {
      newShellTab({
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      });
    } else if (entry.kind === "editor" && entry.filePath) {
      // Re-open the same file. EditorCanvas reads it from disk on mount;
      // unsaved buffer state is intentionally not preserved across close.
      newEditorTab(entry.filePath, {
        ...(entry.rootPath ? { rootPath: entry.rootPath } : {}),
        ...(entry.diff ? { diff: true } : {}),
        ...(entry.diffSnapshot ? { diffSnapshot: entry.diffSnapshot } : {}),
      });
    } else {
      newTab(entry.id, entry.label, {
        restoredSession: true,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      });
    }
  }

  /** Close a tab, prompting for confirmation when closing a running
   *  shell tab and `[shell] prompt_before_close` is true. Editor tabs
   *  with unsaved changes get a lightweight native confirm prompt so
   *  Cmd+W on a dirty file can't silently throw work away.
   *
   *  Shell guard refinement: a bash/zsh sitting at a prompt with just
   *  direnv or `nix develop` loaded is "running" from the kernel's view
   *  (the shell process is alive) but the only thing that would die on
   *  close is the prompt itself — no foreground job, no user task lost.
   *  When `isShellBusy` is wired in, idle shells skip the confirmation;
   *  anything with a real foreground process group still triggers it. */
  function closeTab(tabId: string): void {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const closing = tabs.find((t) => t.id === tabId);
    if (
      closing?.kind === "shell" &&
      closing.shell?.shellState === "running" &&
      shellPromptBeforeCloseRef.current
    ) {
      const busyCheck: Promise<boolean> = isShellBusy
        ? isShellBusy(tabId).catch(() => true)
        : Promise.resolve(true);
      void busyCheck.then((busy) => {
        if (!busy) {
          closeTabNow(tabId);
          return;
        }
        void promptCloseShellTabConfirmation(closing.label).then((allowed) => {
          if (!allowed) return;
          closeTabNow(tabId);
        });
      });
      return;
    }
    if (closing?.kind === "editor" && closing.editor?.isDirty) {
      const ok = window.confirm(
        `"${closing.label}" has unsaved changes. Close without saving?`,
      );
      if (!ok) return;
    }
    closeTabNow(tabId);
  }

  function closeTabNow(tabId: string): void {
    // A restored tab closed before its first interaction never needs
    // its deferred bridge replay (see readyEffects.ts).
    discardDeferredTabOpen(tabId);
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    if (tabs.length === 0) return;
    const closing = tabs.find((t) => t.id === tabId);
    const closedKind = closing?.kind;
    const closedHostId = closing?.hostId;
    if (closing) pushClosedTab(closing);
    let nextBuffer = "";
    let switched = false;
    let becameEmpty = false;
    let shouldRefocusTerminal = false;
    setState((prev) => {
      const prevTabs = (prev.tabs as Tab[] | undefined) ?? [];
      const panel =
        (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
      const list = ((prev.tabs as Tab[] | undefined) ?? []).filter(
        (t) => t.id !== tabId,
      );
      const closingShellIndex = prevTabs
        .filter((t) => t.kind === "shell")
        .findIndex((t) => t.id === tabId);
      let nextActiveSubId = panel.activeSubId;
      if (closedKind === "shell" && panel.activeSubId === tabId) {
        const remainingShells = list.filter((t) => t.kind === "shell");
        const nextShell =
          remainingShells[Math.max(0, closingShellIndex - 1)] ??
          remainingShells[0];
        nextActiveSubId = nextShell?.id ?? "agent-bash";
        shouldRefocusTerminal = true;
      }
      let activeTabId = prev.activeTabId as string | undefined;
      if (activeTabId === tabId) {
        // Prefer the most-recent agent/editor session; if only shells
        // remain (or nothing remains), fall back to the overview
        // pseudo-tab so the canvas returns to the dashboard rather than
        // landing on a shell tab that has no canvas of its own.
        const lastSession = [...list]
          .reverse()
          .find((t) => t.kind === "agent" || t.kind === "editor");
        activeTabId = lastSession ? lastSession.id : OVERVIEW_TAB_ID;
        switched = true;
      }
      const result: Record<string, unknown> = {
        ...prev,
        tabs: list,
        activeTabId,
        ...(nextActiveSubId !== panel.activeSubId
          ? {
              terminalPanel: {
                ...panel,
                activeSubId: nextActiveSubId,
              },
            }
          : {}),
      };
      const bucketKey = projectScopeBucketKey(
        projectsRef.current.activeId,
        projectsRef.current.activeWorkspaceId,
      );
      const bucketRef = tabBucketsRef;
      const inMemoryBucket = bucketRef?.current.get(bucketKey);
      if (bucketRef && inMemoryBucket) {
        const nextBucket = pruneTabFromBucket(
          inMemoryBucket,
          tabId,
          activeTabId,
        );
        if (nextBucket) {
          bucketRef.current.set(bucketKey, nextBucket);
        } else {
          bucketRef.current.delete(bucketKey);
        }
      }
      const persistedBuckets =
        prev.persistedTabBuckets &&
        typeof prev.persistedTabBuckets === "object" &&
        !Array.isArray(prev.persistedTabBuckets)
          ? (prev.persistedTabBuckets as Record<string, TabBucket>)
          : undefined;
      if (persistedBuckets?.[bucketKey]) {
        const nextPersisted = { ...persistedBuckets };
        const nextBucket = pruneTabFromBucket(
          persistedBuckets[bucketKey],
          tabId,
          activeTabId,
        );
        if (nextBucket) {
          nextPersisted[bucketKey] = nextBucket;
        } else {
          delete nextPersisted[bucketKey];
        }
        result.persistedTabBuckets = nextPersisted;
      }
      if (closedKind === "agent") {
        const closedIds = Array.isArray(prev.closedSessionIds)
          ? (prev.closedSessionIds as string[])
          : [];
        result.closedSessionIds = Array.from(
          new Set([...closedIds, tabId]),
        ).slice(-200);
      }
      // Drop a closed tab from the bucket-independent agent-running set so a
      // closed-mid-turn tab can't leave a stale entry behind.
      const running = prev.agentRunningTabs as Record<string, true> | undefined;
      if (running && running[tabId]) {
        const nextRunning = { ...running };
        delete nextRunning[tabId];
        result.agentRunningTabs = nextRunning;
      }
      const attention = prev.agentAttentionTabs as
        | Record<string, true>
        | undefined;
      if (attention && attention[tabId]) {
        const nextAttention = { ...attention };
        delete nextAttention[tabId];
        result.agentAttentionTabs = nextAttention;
      }
      if (closing) {
        const closedSession = recentSessionItemFromClosedTab(
          closing,
          projectsRef.current,
        );
        if (closedSession) {
          const recent =
            (prev.recentSessions as { id: string }[] | undefined) ?? [];
          result.recentSessions = [
            closedSession,
            ...recent.filter((s) => s.id !== closedSession.id),
          ].slice(0, 16);
        }
      }
      const target =
        activeTabId !== OVERVIEW_TAB_ID
          ? list.find((t) => t.id === activeTabId)
          : undefined;
      if (!target) {
        // No session-tab to mirror — clear the per-tab keys so a stale
        // /messages or /draft can't leak into the overview view.
        becameEmpty = list.length === 0;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = undefined;
        }
        result.empty = true;
        result.hasTabs = list.length > 0;
      } else {
        nextBuffer = target.terminalBuffer ?? "";
        const targetRec = target as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = targetRec[key as string];
        }
        result.sidebar = recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          target.model,
        );
        result.empty = false;
        result.hasTabs = true;
      }
      return result;
    });
    if (switched) dispatchTerminalReplay(nextBuffer);
    if (shouldRefocusTerminal) focusTerminalPanelSoon();
    // Tear down bridge session whether we became empty or not — both
    // paths fire tab_close and the bridge no-ops on unknown tab ids.
    void becameEmpty;
    const closePayload = JSON.stringify({ type: "tab_close", tabId });
    const closeAgent = isRemoteHostId(closedHostId)
      ? remoteHostInvoke(closedHostId, "agent_command", { payload: closePayload })
      : invoke("agent_command", { payload: closePayload });
    closeAgent.catch(() => {
      /* ignore — UI already closed */
    });
    // M6 P1: shell tabs own a PTY in the Rust shell registry. Close
    // it too so the child process is reaped and the reader thread
    // joins (no zombies on tab close).
    if (closedKind === "shell") {
      const close = isRemoteHostId(closedHostId)
        ? remoteHostInvoke(closedHostId, "shell_close", { tabId })
        : invoke("shell_close", { tabId });
      close.catch(() => {
        /* idempotent — already torn down by natural exit */
      });
    }
    // Editor tabs own a Monaco model. Dispose it explicitly here so a
    // closed tab doesn't leak — the buffer cache is intentionally
    // long-lived across hidden project buckets (a tab the user can
    // still come back to keeps its unsaved buffer), so we can't rely
    // on a "tab not visible" prune.
    if (closedKind === "editor") {
      disposeEditorBuffer(tabId);
    }
    window.dispatchEvent(new Event(SESSION_UI_SNAPSHOT_FLUSH_EVENT));
  }

  /** Close every editor tab whose filePath matches `path` (or is a
   *  descendant when `kind === "dir"`). Imported by the file-tree's
   *  delete action so a moved-to-Trash file can't be resurrected by a
   *  later Cmd+S on the still-open buffer. Routes through `closeTab`
   *  (not `closeTabNow`) so the dirty-buffer confirm prompt still fires
   *  per-tab — a folder delete with unsaved edits inside it can't
   *  silently destroy the in-memory buffer. */
  function closeEditorTabsForPath(path: string, kind: string): void {
    if (!path) return;
    const prefix = `${path.replace(/\/+$/, "")}/`;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    for (const tab of tabs) {
      if (tab.kind !== "editor" || !tab.editor) continue;
      const current = tab.editor.filePath;
      const match =
        kind === "dir"
          ? current === path || current.startsWith(prefix)
          : current === path;
      if (match) closeTab(tab.id);
    }
  }

  return {
    pushClosedTab,
    reopenLastClosedTab,
    closeTab,
    closeTabNow,
    closeEditorTabsForPath,
  };
}
