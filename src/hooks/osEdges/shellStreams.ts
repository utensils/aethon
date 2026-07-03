import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { MutableRefObject } from "react";
import type { ShellMeta, Tab } from "../../types/tab";
import { TERMINAL_REPLAY_MAX } from "../useTabs";
import { remoteHostInvoke } from "../../services/remote";
import { isRemoteHostId } from "../../remoteInvoke";

export interface ShellStreamsDeps {
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  stateRef: MutableRefObject<Record<string, unknown>>;
  appendSystem: (text: string) => void;
  shellInheritEnvRef: MutableRefObject<boolean>;
}

/** How long PTY chunks accumulate before one state flush. The xterm gets
 *  every chunk immediately via the DOM event; the state write only feeds
 *  the replay buffer, so ~10 renders/sec is plenty. Without coalescing a
 *  busy shell (build output) caused hundreds of full-tree React renders
 *  per second — `updateTab` ran per PTY chunk. */
export const SHELL_BUFFER_FLUSH_MS = 100;

/** Closure-scoped coalescer for terminalBuffer appends. Pure-ish and
 *  exported for tests: `flush()` applies all pending chunks through
 *  `updateTab` in one pass per tab. */
export function createShellOutputCoalescer(
  updateTab: ShellStreamsDeps["updateTab"],
  flushMs: number = SHELL_BUFFER_FLUSH_MS,
) {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushTab = (tabId: string) => {
    const chunk = pending.get(tabId);
    if (chunk === undefined) return;
    pending.delete(tabId);
    updateTab(tabId, (t) => {
      const next = t.terminalBuffer + chunk;
      const trimmed =
        next.length > TERMINAL_REPLAY_MAX
          ? next.slice(next.length - TERMINAL_REPLAY_MAX)
          : next;
      return { ...t, terminalBuffer: trimmed };
    });
  };

  const flushAll = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const tabId of [...pending.keys()]) flushTab(tabId);
  };

  return {
    /** Queue a chunk; schedules a flush if one isn't already pending. */
    push(tabId: string, content: string) {
      // Cap the pending chunk itself — anything beyond the replay max
      // would be sliced away at flush time anyway, and an unbounded
      // pending string is exactly the kind of buffer this module exists
      // to avoid.
      const next = (pending.get(tabId) ?? "") + content;
      pending.set(
        tabId,
        next.length > TERMINAL_REPLAY_MAX
          ? next.slice(next.length - TERMINAL_REPLAY_MAX)
          : next,
      );
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          flushAll();
        }, flushMs);
      }
    },
    /** Flush one tab synchronously (shell exit must not race the buffer). */
    flushTab,
    /** Flush everything and cancel the timer (unsubscribe path). */
    flushAll,
  };
}

/** PTY stream listeners: `shell-output` appends to the tab's
 *  terminalBuffer (trimmed to TERMINAL_REPLAY_MAX, coalesced to one state
 *  write per SHELL_BUFFER_FLUSH_MS) and dispatches a per-tab DOM event so
 *  the shell-canvas composite writes the chunk to its xterm immediately.
 *  `shell-exit` restarts the same shell tab id when the tab still exists,
 *  falling back to "exited" only if the respawn fails. `shell-title` mirrors
 *  OSC 0/1/2 title-set sequences into the tab
 *  label (truncated to 64 chars).
 *
 *  Inactive shell-tab output stays buffered until the user switches
 *  to it — the canvas replays on mount, matching the read-only
 *  Terminal panel's agent-bash buffering. */
export function subscribeShellStreams(deps: ShellStreamsDeps): () => void {
  const { updateTab } = deps;
  const coalescer = createShellOutputCoalescer(updateTab);
  const restartingTabs = new Set<string>();

  const unlistenShellOutput = listen<{ tabId: string; content: string }>(
    "shell-output",
    (event) => {
      const { tabId, content } = event.payload;
      if (!tabId || typeof content !== "string") return;
      coalescer.push(tabId, content);
      window.dispatchEvent(
        new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
      );
    },
  );

  const unlistenShellExit = listen<{ tabId: string; code: number | null }>(
    "shell-exit",
    (event) => {
      const { tabId, code } = event.payload;
      if (!tabId) return;
      // The final output chunks must land in the replay buffer before the
      // exited state renders (replay/persist read the buffer).
      coalescer.flushTab(tabId);
      void respawnShellTab(deps, restartingTabs, tabId, code);
    },
  );

  const unlistenShellTitle = listen<{ tabId: string; title: string }>(
    "shell-title",
    (event) => {
      const { tabId, title } = event.payload;
      if (!tabId || typeof title !== "string" || title.length === 0) return;
      const safe = title.length > 64 ? `${title.slice(0, 61)}…` : title;
      updateTab(tabId, (t) => {
        if (t.kind !== "shell" || t.label === safe) return t;
        return { ...t, label: safe };
      });
    },
  );
  const unlistenRemoteShell = listen<{
    hostId: string;
    topic: string;
    payload: unknown;
  }>("remote-host-event", (event) => {
    const { hostId, topic, payload } = event.payload;
    if (!isRemoteHostId(hostId) || !payload || typeof payload !== "object") {
      return;
    }
    const data = payload as Record<string, unknown>;
    const tabId = typeof data.tabId === "string" ? data.tabId : "";
    if (!tabId || liveTabHostId(deps.stateRef, tabId) !== hostId) return;
    if (topic === "shell-output") {
      const content = typeof data.content === "string" ? data.content : "";
      if (!content) return;
      coalescer.push(tabId, content);
      window.dispatchEvent(
        new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
      );
      return;
    }
    if (topic === "shell-exit") {
      const code = typeof data.code === "number" ? data.code : null;
      coalescer.flushTab(tabId);
      void respawnShellTab(deps, restartingTabs, tabId, code);
      return;
    }
    if (topic === "shell-title") {
      const title = typeof data.title === "string" ? data.title : "";
      if (!title) return;
      const safe = title.length > 64 ? `${title.slice(0, 61)}…` : title;
      updateTab(tabId, (t) => {
        if (t.kind !== "shell" || t.label === safe) return t;
        return { ...t, label: safe };
      });
    }
  });

  return () => {
    coalescer.flushAll();
    unlistenShellOutput.then((fn) => fn());
    unlistenShellExit.then((fn) => fn());
    unlistenShellTitle.then((fn) => fn());
    unlistenRemoteShell.then((fn) => fn());
  };
}

function liveShellTab(
  stateRef: MutableRefObject<Record<string, unknown>>,
  tabId: string,
): Tab | undefined {
  const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  return tabs.find(
    (tab) => tab.id === tabId && tab.kind === "shell" && tab.shell,
  );
}

function shellOpenArgs(
  tabId: string,
  shell: ShellMeta,
  inheritEnv: boolean,
): Record<string, unknown> {
  return {
    tabId,
    ...(shell.command ? { command: shell.command } : {}),
    ...(shell.args.length > 0 ? { args: shell.args } : {}),
    ...(shell.cwd ? { cwd: shell.cwd } : {}),
    ...(shell.shareMode !== "private" ? { shareMode: shell.shareMode } : {}),
    ...(inheritEnv === false ? { inheritEnv: false } : {}),
  };
}

function liveTabHostId(
  stateRef: MutableRefObject<Record<string, unknown>>,
  tabId: string,
): string | undefined {
  const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
  return tabs.find((tab) => tab.id === tabId)?.hostId;
}

async function respawnShellTab(
  deps: ShellStreamsDeps,
  restartingTabs: Set<string>,
  tabId: string,
  code: number | null,
): Promise<void> {
  if (restartingTabs.has(tabId)) return;
  const tab = liveShellTab(deps.stateRef, tabId);
  if (!tab?.shell) return;

  restartingTabs.add(tabId);
  updateShellState(deps, tabId, "starting", code);

  try {
    const hostId = tab.hostId;
    const invokeShell = (cmd: string, args: Record<string, unknown>) =>
      isRemoteHostId(hostId)
        ? remoteHostInvoke(hostId, cmd, args)
        : invoke(cmd, args);
    await invokeShell("shell_close", { tabId });
    const latest = liveShellTab(deps.stateRef, tabId);
    if (!latest?.shell) return;
    await invokeShell("shell_open", {
      args: shellOpenArgs(tabId, latest.shell, deps.shellInheritEnvRef.current),
    });
    deps.updateTab(tabId, (t) => {
      if (t.kind !== "shell" || !t.shell) return t;
      const shell = { ...t.shell, shellState: "running" as const };
      delete shell.exitCode;
      delete shell.restartOnMount;
      return { ...t, shell };
    });
  } catch (err) {
    deps.appendSystem(
      `Shell tab exited and could not be restarted: ${String(err)}`,
    );
    updateShellState(deps, tabId, "exited", -1);
  } finally {
    restartingTabs.delete(tabId);
  }
}

function updateShellState(
  deps: ShellStreamsDeps,
  tabId: string,
  shellState: ShellMeta["shellState"],
  code: number | null,
): void {
  deps.updateTab(tabId, (t) => {
    if (t.kind !== "shell" || !t.shell) return t;
    const shell = {
      ...t.shell,
      shellState,
      ...(typeof code === "number" ? { exitCode: code } : {}),
    };
    if (shellState === "exited" && code === -1) delete shell.restartOnMount;
    return {
      ...t,
      shell,
    };
  });
}
