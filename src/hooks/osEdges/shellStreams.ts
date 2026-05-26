import { listen } from "@tauri-apps/api/event";
import type { Tab } from "../../types/tab";
import { TERMINAL_REPLAY_MAX } from "../useTabs";

export interface ShellStreamsDeps {
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

/** PTY stream listeners: `shell-output` appends to the tab's
 *  terminalBuffer (trimmed to TERMINAL_REPLAY_MAX) and dispatches a
 *  per-tab DOM event so the shell-canvas composite writes the chunk
 *  to its xterm. `shell-exit` flips the tab's shellState to "exited"
 *  with the exit code. `shell-title` mirrors OSC 0/1/2 title-set
 *  sequences into the tab label (truncated to 64 chars).
 *
 *  Inactive shell-tab output stays buffered until the user switches
 *  to it — the canvas replays on mount, matching the read-only
 *  Terminal panel's agent-bash buffering. */
export function subscribeShellStreams(deps: ShellStreamsDeps): () => void {
  const { updateTab } = deps;

  const unlistenShellOutput = listen<{ tabId: string; content: string }>(
    "shell-output",
    (event) => {
      const { tabId, content } = event.payload;
      if (!tabId || typeof content !== "string") return;
      updateTab(tabId, (t) => {
        const next = t.terminalBuffer + content;
        const trimmed =
          next.length > TERMINAL_REPLAY_MAX
            ? next.slice(next.length - TERMINAL_REPLAY_MAX)
            : next;
        return { ...t, terminalBuffer: trimmed };
      });
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
      updateTab(tabId, (t) => {
        if (t.kind !== "shell" || !t.shell) return t;
        return {
          ...t,
          shell: {
            ...t.shell,
            shellState: "exited",
            ...(typeof code === "number" ? { exitCode: code } : {}),
          },
        };
      });
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

  return () => {
    unlistenShellOutput.then((fn) => fn());
    unlistenShellExit.then((fn) => fn());
    unlistenShellTitle.then((fn) => fn());
  };
}
