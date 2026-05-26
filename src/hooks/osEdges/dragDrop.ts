import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../../types/tab";
import { shellQuoteAll } from "../../utils/shellQuote";

export interface DragDropDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
}

/** P4: drag-and-drop file paths from the OS. Tauri 2's webview
 *  exposes the paths directly (HTML5 dataTransfer is sandboxed and
 *  only yields File handles). Routing:
 *
 *  * Drop on the bottom terminal panel while a shell sub-tab is
 *    active, or anywhere when the active top-level tab is a shell
 *    → write shell-quoted POSIX path(s) into the PTY via
 *    `shell_input`. Each path is single-quote-wrapped via the
 *    shellQuote helper so spaces / metacharacters never break the
 *    paste into multiple tokens.
 *  * Otherwise (active tab is an agent tab) → append `@<absolute-
 *    path>` tokens to the draft.
 *
 *  Position hit-test uses `document.elementFromPoint` against
 *  physical-to-CSS-pixel-converted drop coordinates so the user can
 *  drop directly onto the panel they want to receive the path. */
export function subscribeDragDrop(deps: DragDropDeps): () => void {
  const { stateRef, updateTab } = deps;

  const disposer = (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return await getCurrentWebview().onDragDropEvent((evt) => {
        if (evt.payload.type !== "drop") return;
        const paths = evt.payload.paths ?? [];
        if (paths.length === 0) return;
        const activeId = stateRef.current.activeTabId as string | undefined;
        if (!activeId) return;
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const tab = tabs.find((t) => t.id === activeId);
        if (!tab) return;

        // Resolve which shell — if any — should receive the drop.
        // Top-level shell tab wins outright; otherwise, hit-test the
        // drop position against the bottom terminal panel and inspect
        // the active sub-tab.
        let targetShellId: string | null = null;
        if (tab.kind === "shell") {
          targetShellId = tab.id;
        } else {
          const pos = evt.payload.position;
          const dpr = window.devicePixelRatio || 1;
          const cssX = pos.x / dpr;
          const cssY = pos.y / dpr;
          const elem = document.elementFromPoint(cssX, cssY);
          const inPanel = elem?.closest(".ae-terminal-panel") ?? null;
          if (inPanel) {
            const tp =
              (stateRef.current.terminalPanel as
                | { activeSubId?: string }
                | undefined) ?? {};
            const subId = tp.activeSubId;
            if (subId && subId !== "agent-bash") {
              const subTab = tabs.find((t) => t.id === subId);
              if (subTab && subTab.kind === "shell") {
                targetShellId = subTab.id;
              }
            }
          }
        }

        if (targetShellId) {
          const data = shellQuoteAll(paths);
          void invoke("shell_input", {
            tabId: targetShellId,
            data,
          }).catch(() => {
            /* PTY closed mid-drop — drop silently */
          });
          return;
        }

        if (tab.kind !== "agent") return;
        const tokens = paths.map((p) => `@${p}`).join(" ");
        updateTab(activeId, (t) => ({
          ...t,
          draft: t.draft.length > 0 ? `${t.draft} ${tokens}` : tokens,
        }));
      });
    } catch (err) {
      console.warn("dragdrop subscribe failed:", err);
      return undefined;
    }
  })();

  return () => {
    disposer.then((fn) => fn?.());
  };
}
