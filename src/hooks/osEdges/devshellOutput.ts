import { listen } from "@tauri-apps/api/event";
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { Tab } from "../../types/tab";
import { TERMINAL_REPLAY_MAX } from "../useTabs";

export interface DevshellOutputDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

interface DevshellOutputPayload {
  root?: string;
  kind?: string;
  stream?: "status" | "stderr" | string;
  content?: string;
}

interface DevshellResolvingPayload {
  root?: string;
  kind?: string;
}

interface DevshellReadyPayload {
  root?: string;
  kind?: string;
  durationMs?: number;
  varCount?: number;
}

interface DevshellFailedPayload {
  root?: string;
  kind?: string;
  reason?: string;
}

export function subscribeDevshellOutput(deps: DevshellOutputDeps): () => void {
  const unlistenOutput = listen<DevshellOutputPayload>("devshell-output", (event) => {
    const root = event.payload?.root;
    const raw = event.payload?.content;
    if (!root || typeof raw !== "string" || raw.length === 0) return;
    appendForRoot(deps, root, raw);
  });

  const unlistenResolving = listen<DevshellResolvingPayload>(
    "devshell-resolving",
    (event) => {
      const { root, kind } = event.payload ?? {};
      if (!root) return;
      appendForRoot(
        deps,
        root,
        `\r\n[devshell] Preparing ${kindLabel(kind)} devshell for this workspace...\r\n`,
      );
    },
  );

  const unlistenReady = listen<DevshellReadyPayload>("devshell-ready", (event) => {
    const { root, kind, durationMs, varCount } = event.payload ?? {};
    if (!root) return;
    const duration =
      typeof durationMs === "number" ? ` in ${(durationMs / 1000).toFixed(1)}s` : "";
    const vars = typeof varCount === "number" ? ` (${varCount} vars)` : "";
    appendForRoot(
      deps,
      root,
      `[devshell] ${kindLabel(kind)} devshell ready${duration}${vars}\r\n`,
    );
  });

  const unlistenFailed = listen<DevshellFailedPayload>(
    "devshell-failed",
    (event) => {
      const { root, kind, reason } = event.payload ?? {};
      if (!root) return;
      appendForRoot(
        deps,
        root,
        `[devshell] ${kindLabel(kind)} devshell failed${
          reason ? `: ${reason}` : ""
        }\r\n`,
      );
    },
  );

  return () => {
    unlistenOutput.then(safeUnlisten).catch(() => {});
    unlistenResolving.then(safeUnlisten).catch(() => {});
    unlistenReady.then(safeUnlisten).catch(() => {});
    unlistenFailed.then(safeUnlisten).catch(() => {});
  };
}

function safeUnlisten(fn: () => void): void {
  try {
    fn();
  } catch {
    // Reload/shutdown can invalidate Tauri listener ids before React cleanup.
  }
}

function appendForRoot(
  deps: DevshellOutputDeps,
  root: string,
  rawContent: string,
): void {
  const content = normalizeTerminal(rawContent);
  if (!content) return;
  const state = deps.stateRef.current;
  const tabs = matchingTabs(state, root);

  deps.setState((prev) => {
    const term = (prev.terminal as Record<string, unknown> | undefined) ?? {};
    const buffers = (term.buffer as Record<string, string> | undefined) ?? {};
    const devshell =
      (prev.devshell as Record<string, unknown> | undefined) ?? {};
    const outputByRoot =
      (devshell.outputByRoot as Record<string, string> | undefined) ?? {};
    const tabs = (prev.tabs as Tab[] | undefined) ?? [];
    const nextBuffers = { ...buffers };
    const nextTabs = tabs.map((tab) => {
      const cwd = cwdForTab(tab);
      if (!cwd || !isUnderRoot(cwd, root)) {
        return tab;
      }
      const next = appendTerminal(tab, content);
      nextBuffers[tab.id] = next.terminalBuffer;
      return next;
    });

    return {
      ...prev,
      tabs: nextTabs,
      devshell: {
        ...devshell,
        outputByRoot: {
          ...outputByRoot,
          [root]: trimTerminal((outputByRoot[root] ?? "") + content),
        },
      },
      terminal: {
        ...term,
        buffer: nextBuffers,
      },
    };
  });

  const activeTabId = state.activeTabId as string | undefined;
  const terminalPanel =
    state.terminalPanel as { activeSubId?: string } | undefined;
  const activeSubId = terminalPanel?.activeSubId;
  for (const tab of tabs) {
    if (tab.kind === "shell") {
      if (activeSubId === tab.id) {
        window.dispatchEvent(
          new CustomEvent(`aethon:shell-output:${tab.id}`, { detail: content }),
        );
      }
    } else {
      window.dispatchEvent(
        new CustomEvent("aethon:terminal-tap", {
          detail: { tabId: tab.id, content },
        }),
      );
      if (activeTabId === tab.id) {
        window.dispatchEvent(new CustomEvent("aethon:terminal", { detail: content }));
      }
    }
  }
}

function appendTerminal(tab: Tab, content: string): Tab {
  return {
    ...tab,
    terminalBuffer: trimTerminal((tab.terminalBuffer ?? "") + content),
  };
}

function trimTerminal(value: string): string {
  return value.length > TERMINAL_REPLAY_MAX
    ? value.slice(value.length - TERMINAL_REPLAY_MAX)
    : value;
}

function normalizeTerminal(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function matchingTabs(state: Record<string, unknown>, root: string): Tab[] {
  return ((state.tabs as Tab[] | undefined) ?? []).filter(
    (tab) => {
      const cwd = cwdForTab(tab);
      return !!cwd && isUnderRoot(cwd, root);
    },
  );
}

function cwdForTab(tab: Tab): string | undefined {
  if (tab.kind === "shell") return tab.shell?.cwd;
  return tab.cwd;
}

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd.startsWith(prefix);
}

function kindLabel(kind: string | undefined): string {
  if (kind === "flake") return "Nix";
  if (kind === "direnv") return "direnv";
  if (kind === "shell") return "nix-shell";
  return "Nix";
}
