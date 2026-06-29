import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface MenuDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  newTab: () => void;
  newShellTab: () => void;
  closeTab: (tabId: string) => void;
  activateTabAnywhere: (tabId: string) => void;
  nextTab: (direction: 1 | -1) => void;
  toggleTerminal: () => void;
  toggleFilesSidebar: () => void;
  togglePlanMode: () => void;
  openSettings: (section?: string) => void;
  openScheduledTasks: () => void;
  clearChat: () => void;
  stopPrompt: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  appendSystem: (text: string) => void;
}

/** Native menu activations land on the `menu` event with the item id.
 *  Routing mirrors the keyboard-shortcut paths so menu and Cmd+T /
 *  Cmd+Shift+] / etc. always do the same thing.
 *
 *  Extension menu items use the `ext:<action>` prefix to avoid
 *  colliding with built-in ids; they're forwarded through the
 *  `a2ui_event` channel as a synthetic `menu-item` invocation so a
 *  paired `aethon.onEvent({componentType:"menu-item",
 *  descendantId:"<action>"}, handler)` fires.
 *
 *  "File → New Tab" (Cmd+T) opens an agent tab — the menu can't
 *  observe webview focus, so it picks the safer default. The webview
 *  keydown handler intercepts Cmd+T when focus is in the bottom
 *  terminal panel and routes to newShellTab there. */
export function subscribeMenu(deps: MenuDeps): () => void {
  const {
    stateRef,
    newTab,
    newShellTab,
    closeTab,
    activateTabAnywhere,
    nextTab,
    toggleTerminal,
    toggleFilesSidebar,
    togglePlanMode,
    openSettings,
    openScheduledTasks,
    clearChat,
    stopPrompt,
    checkForUpdates,
    appendSystem,
  } = deps;

  const unlistenMenu = listen<string>("menu", (event) => {
    const id = event.payload;
    if (id.startsWith("ext:")) {
      const action = id.slice(4);
      invoke("dispatch_a2ui_event", {
        event: JSON.stringify({
          componentId: `menu-item__tpl__${action}`,
          componentType: "menu-item",
          templateRootType: "menu-item",
          eventType: "invoke",
          data: { action },
        }),
        tabId: stateRef.current.activeTabId,
      }).catch(() => {
        /* bridge gone or webview reload mid-flight */
      });
      return;
    }
    if (id.startsWith("tray:session:")) {
      activateTabAnywhere(id.slice("tray:session:".length));
      return;
    }
    switch (id) {
      // The legacy "new_agent_tab" id is kept as an alias in case any
      // older payload references it.
      case "new_tab":
      case "new_agent_tab":
        newTab();
        break;
      case "new_shell_tab":
        newShellTab();
        break;
      // Editor file ops — forwarded to the active editor canvas (and the
      // file tree for New File) via window events so the menu, the
      // in-editor buttons, and Monaco's own Cmd+S all converge.
      case "new_file":
        window.dispatchEvent(new Event("aethon:new-file"));
        break;
      case "save_file":
        window.dispatchEvent(new Event("aethon:editor-save"));
        break;
      case "revert_file":
        window.dispatchEvent(new Event("aethon:editor-revert"));
        break;
      case "close_tab": {
        const activeId = stateRef.current.activeTabId as string | undefined;
        if (activeId) closeTab(activeId);
        break;
      }
      case "next_tab":
        nextTab(1);
        break;
      case "prev_tab":
        nextTab(-1);
        break;
      case "toggle_terminal":
        toggleTerminal();
        break;
      case "toggle_files": {
        // Forward to the FileTreePanel's hidden window event so the
        // panel toggles regardless of which surface (menu, sidebar
        // item, future shortcut) fired the request.
        window.dispatchEvent(new Event("aethon:toggle-file-tree"));
        break;
      }
      case "toggle_files_sidebar":
        toggleFilesSidebar();
        break;
      case "toggle_plan_mode":
        togglePlanMode();
        break;
      case "scheduled_tasks":
        openScheduledTasks();
        break;
      case "manage_extensions":
        openSettings("extensions");
        break;
      case "clear_chat":
        clearChat();
        break;
      case "stop_prompt":
        void stopPrompt();
        break;
      case "check_updates": {
        checkForUpdates().catch((err) => {
          appendSystem(`Update check failed: ${err}`);
        });
        break;
      }
      case "help_docs": {
        openUrl("https://utensils.io/aethon/").catch(() => {
          /* opener errors are noisy and rarely actionable */
        });
        break;
      }
      case "help_issues": {
        openUrl("https://github.com/utensils/aethon/issues/new").catch(() => {
          /* opener errors are noisy and rarely actionable */
        });
        break;
      }
    }
  });

  return () => {
    unlistenMenu.then((fn) => fn());
  };
}
