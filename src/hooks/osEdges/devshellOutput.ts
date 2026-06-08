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

export function subscribeDevshellOutput(deps: DevshellOutputDeps): () => void {
  const unlisten = listen<DevshellOutputPayload>("devshell-output", (event) => {
    const root = event.payload?.root;
    const raw = event.payload?.content;
    if (!root || typeof raw !== "string" || raw.length === 0) return;
    const content = raw.replace(/\r?\n/g, "\r\n");
    const state = deps.stateRef.current;
    const tabs = ((state.tabs as Tab[] | undefined) ?? []).filter(
      (tab) => tab.kind === "agent" && tab.cwd && isUnderRoot(tab.cwd, root),
    );
    if (tabs.length === 0) return;

    for (const tab of tabs) {
      deps.updateTab(tab.id, (current) => appendTerminal(current, content));
    }

    deps.setState((prev) => {
      const term = (prev.terminal as Record<string, unknown> | undefined) ?? {};
      const buffers = (term.buffer as Record<string, string> | undefined) ?? {};
      const nextBuffers = { ...buffers };
      for (const tab of tabs) {
        nextBuffers[tab.id] = trimTerminal((nextBuffers[tab.id] ?? "") + content);
      }
      return {
        ...prev,
        terminal: {
          ...term,
          buffer: nextBuffers,
        },
      };
    });

    const activeTabId = state.activeTabId as string | undefined;
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
      window.dispatchEvent(
        new CustomEvent("aethon:terminal", { detail: content }),
      );
      window.dispatchEvent(
        new CustomEvent("aethon:terminal-tap", {
          detail: { tabId: activeTabId, content },
        }),
      );
    }
  });

  return () => {
    unlisten.then((fn) => fn());
  };
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

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd.startsWith(prefix);
}
