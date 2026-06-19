import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { canonicalCombo } from "../utils/keybindings";
import { focusTerminalPanelSoon, isFocusInTerminalPanel } from "../utils/focus";
import {
  AGENT_BASH_SUB_ID,
  resolveActiveSubIdFromState,
} from "../extensions/default-layout/shell/panel-helpers";
import type { Tab } from "../types/tab";
import { isAgentTabBusy } from "../utils/agentBusy";

interface NotificationInput {
  id: string;
  title: string;
  message?: string;
  kind?: "info" | "success" | "warning" | "error";
  durationMs?: number | null;
}

function activeAgentTabIsBusy(state: Record<string, unknown>): boolean {
  const activeTabId = state.activeTabId as string | undefined;
  if (!activeTabId) return false;
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return false;
  if ((activeTab.kind ?? "agent") !== "agent") return false;
  return (
    isAgentTabBusy(activeTab, { includeQueue: true }) ||
    state.waiting === true ||
    ((state.queueCount as number | undefined) ?? 0) > 0
  );
}

export interface UseKeyboardShortcutsContext {
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** Map of canonical combo string ("meta+shift+p") to the registered
   *  binding. Extensions populate this via `aethon.registerKeybinding`;
   *  matches fire BEFORE built-in handlers so an extension can override
   *  default chrome actions. */
  extensionKeybindingsRef: MutableRefObject<
    Map<string, { combo: string; action: string; description?: string }>
  >;

  // Built-in actions, all hoisted from App or hook destructures.
  toggleTerminalAndFocus: () => void;
  toggleSidebar: () => void;
  toggleFilesSidebar: () => void;
  /** Toggle markdown preview mode on the active editor tab (Cmd+Shift+V).
   *  No-op when the active tab isn't a markdown file. */
  toggleEditorPreview: () => void;
  clearChat: () => void;
  stopPrompt: () => void | Promise<void>;
  newTab: () => void;
  newShellTab: () => void;
  nextTab: (direction: 1 | -1) => void;
  nextShellSubTab: (direction: 1 | -1) => void;
  moveActiveTab: (direction: 1 | -1) => void;
  moveActiveShellSubTab: (direction: 1 | -1) => void;
  jumpToTab: (idx: number) => void;
  jumpToShellSubTab: (idx: number) => void;
  reopenLastClosedTab: () => void;
  closeTab: (tabId: string) => void;
  toggleSessionSearch: () => void;
  openPalette: (mode: "switcher" | "commands" | "files") => void;
  closePalette: () => void;
  togglePlanMode: () => void;
  adjustZoom: (delta: number) => void;
  resetZoom: () => void;
  toggleFocusComposerTerminal: () => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  focusActiveContextInput: () => void;
  exportActiveChatMarkdown: () => Promise<void>;
  pushNotification: (n: NotificationInput) => void;
  toggleAccounts: () => void;
}

/**
 * Document-bound `keydown` handler implementing every built-in shortcut.
 * Bound on the document with `useCapture: true` so we run BEFORE xterm's
 * own keydown listener — `stopPropagation` then keeps the keystroke out
 * of the shell when we handle it.
 *
 * Extension-registered keybindings are checked first so they can
 * intentionally replace default chrome actions; matches dispatch through
 * the existing a2ui_event channel.
 *
 * Many shortcuts are focus-aware: when focus is inside the bottom
 * terminal panel, Cmd+T / Cmd+Shift+] / Cmd+1..9 / Cmd+Opt+] etc. operate
 * on the shell sub-tabs instead of the agent tab strip.
 */
export function useKeyboardShortcuts(ctx: UseKeyboardShortcutsContext): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const combo = canonicalCombo(e);
      if (combo) {
        const binding = ctx.extensionKeybindingsRef.current.get(combo);
        if (binding) {
          e.preventDefault();
          e.stopPropagation();
          invoke("dispatch_a2ui_event", {
            event: JSON.stringify({
              componentId: `keybinding__tpl__${combo}`,
              componentType: "keybinding",
              templateRootType: "keybinding",
              eventType: "invoke",
              data: { combo, action: binding.action },
            }),
            tabId: ctx.stateRef.current.activeTabId,
          }).catch(() => {
            /* ignore — bridge gone or webview reload mid-flight */
          });
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      // Shift+Tab: toggle Plan mode for the active agent session. Let
      // xterm keep reverse-tab when the bottom terminal panel has focus.
      if (
        e.key === "Tab" &&
        e.shiftKey &&
        !mod &&
        !e.altKey &&
        !isFocusInTerminalPanel()
      ) {
        e.preventDefault();
        e.stopPropagation();
        ctx.togglePlanMode();
        return;
      }
      // Cmd+`: toggle bottom terminal panel + move focus there/back.
      if (e.key === "`" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleTerminalAndFocus();
        return;
      }
      // Cmd+J: toggle the sidebar's file-tree panel. Mirrors the View
      // menu's "Toggle Files" item.
      if (e.key.toLowerCase() === "j" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("aethon:toggle-file-tree"));
        return;
      }
      // Cmd+Shift+V: toggle markdown preview on the active editor
      // tab. No-op when the active tab isn't a markdown file.
      if (e.key.toLowerCase() === "v" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleEditorPreview();
        return;
      }
      if (e.key.toLowerCase() === "b" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleSidebar();
        return;
      }
      // Cmd+D: toggle the right-hand files sidebar.
      if (e.key.toLowerCase() === "d" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleFilesSidebar();
        return;
      }
      if (e.key.toLowerCase() === "k" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.clearChat();
        return;
      }
      if (e.key === "." && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        void ctx.stopPrompt();
        return;
      }
      // Cmd+Shift+T: explicit new shell sub-tab in the bottom panel.
      if (e.key.toLowerCase() === "t" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.newShellTab();
        focusTerminalPanelSoon();
        return;
      }
      // Cmd+T: focus-aware new tab. Shell sub-tabs only own this when
      // keyboard focus is actually inside the bottom terminal panel.
      if (e.key.toLowerCase() === "t" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) {
          ctx.newShellTab();
          focusTerminalPanelSoon();
        } else {
          ctx.newTab();
        }
        return;
      }
      // Cmd+Shift+] / Cmd+Shift+[: next/prev tab. Focus-aware: panel
      // cycles sub-tabs. Browser/terminal convention (iTerm, Terminal.app,
      // most modern editors). Match purely on `e.code` for layout-
      // independence — matching on `e.key === "}"` would also fire on
      // layouts where Shift+<some other physical key> produces `}` (e.g.
      // some European layouts where the bracket lives behind AltGr), which
      // would surprise users who didn't press the bracket key.
      if (e.code === "BracketRight" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) ctx.nextShellSubTab(1);
        else ctx.nextTab(1);
        return;
      }
      if (e.code === "BracketLeft" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) ctx.nextShellSubTab(-1);
        else ctx.nextTab(-1);
        return;
      }
      // Cmd+Opt+] / Cmd+Opt+[: reorder active tab. Focus-aware.
      if (e.code === "BracketRight" && mod && e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) ctx.moveActiveShellSubTab(1);
        else ctx.moveActiveTab(1);
        return;
      }
      if (e.code === "BracketLeft" && mod && e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) ctx.moveActiveShellSubTab(-1);
        else ctx.moveActiveTab(-1);
        return;
      }
      // Cmd+1..8 → jump to tab N (1-indexed); Cmd+9 → jump to last.
      // Focus-aware: in the bottom panel, indices map to sub-tabs
      // (0 = agent-bash, 1..N = shells).
      if (mod && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        if (isFocusInTerminalPanel()) {
          const shellSubTabs = (
            (ctx.stateRef.current.tabs as Tab[] | undefined) ?? []
          ).filter((t) => t.kind === "shell");
          const total = 1 + shellSubTabs.length;
          if (total === 0) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "9") ctx.jumpToShellSubTab(total - 1);
          else ctx.jumpToShellSubTab(parseInt(e.key, 10) - 1);
          return;
        }
        const agentTabs = (
          (ctx.stateRef.current.tabs as Tab[] | undefined) ?? []
        ).filter((t) => t.kind !== "shell");
        if (agentTabs.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "9") ctx.jumpToTab(agentTabs.length - 1);
        else ctx.jumpToTab(parseInt(e.key, 10) - 1);
        return;
      }
      // Cmd+Opt+T: reopen most-recently-closed tab. macOS lets Option
      // mutate the printable-key value (Opt+T arrives as `e.key === "†"`),
      // so match the *physical* key via `e.code === "KeyT"` whenever Alt
      // is part of the shortcut.
      if (
        mod &&
        e.altKey &&
        !e.shiftKey &&
        (e.code === "KeyT" || e.key.toLowerCase() === "t")
      ) {
        e.preventDefault();
        e.stopPropagation();
        ctx.reopenLastClosedTab();
        return;
      }
      // Cmd+W: close active tab. Focus-aware — when keyboard focus is
      // inside the bottom terminal panel, close the active shell
      // sub-tab instead so users don't have to switch focus back up
      // just to dismiss a shell. The always-present agent-bash sub-tab
      // is read-only and has no /tabs entry; if it's the active sub
      // we no-op rather than falling through and accidentally closing
      // the agent tab above.
      if (e.key.toLowerCase() === "w" && mod && !e.shiftKey && !e.altKey) {
        if (isFocusInTerminalPanel()) {
          // Resolve the *displayed* sub-tab — not the raw state — so
          // Cmd+W matches what the user sees. The panel clamps a stale
          // "agent-bash" requestedActiveId to the first shell when the
          // overview owns the canvas; reading raw state here would miss
          // that and silently no-op.
          const subId = resolveActiveSubIdFromState(ctx.stateRef.current);
          if (!subId || subId === AGENT_BASH_SUB_ID) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          ctx.closeTab(subId);
          return;
        }
        const activeId = ctx.stateRef.current.activeTabId as string | undefined;
        if (!activeId) return;
        e.preventDefault();
        e.stopPropagation();
        ctx.closeTab(activeId);
        return;
      }
      // Cmd+Shift+F: cross-session search overlay.
      if (e.key.toLowerCase() === "f" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleSessionSearch();
        return;
      }
      // Cmd+Shift+P: command palette in commands mode (checked before
      // plain Cmd+P so shift takes precedence). Holds the previous
      // switcher content (tabs / sessions / projects / layouts /
      // themes / models) via the @ prefix once the palette is open.
      if (e.key.toLowerCase() === "p" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.openPalette("commands");
        return;
      }
      // Cmd+P: VSCode-style file fuzzy search. Walks the active
      // project's tree (skipping common ignored dirs), surfaces a
      // ranked file list, opens the selection in an editor tab.
      if (e.key.toLowerCase() === "p" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.openPalette("files");
        return;
      }
      // Esc closes the active overlay, with palette taking precedence
      // because it can sit on top of Settings.
      if (e.key === "Escape") {
        const state = ctx.stateRef.current;
        const palette = state.palette as { open?: boolean } | undefined;
        if (palette?.open) {
          e.preventDefault();
          e.stopPropagation();
          ctx.closePalette();
          return;
        }
        const settings = state.settings as { open?: boolean } | undefined;
        if (settings?.open) {
          e.preventDefault();
          e.stopPropagation();
          ctx.closeSettings();
          return;
        }
        const authProfiles = state.authProfiles as
          | { modal?: { open?: boolean } }
          | undefined;
        if (authProfiles?.modal?.open) {
          // Let an in-progress inline rename swallow Escape (to cancel the
          // edit) rather than closing the whole panel out from under it.
          const focused = document.activeElement;
          if (focused?.classList.contains("ae-auth-rename-input")) return;
          e.preventDefault();
          e.stopPropagation();
          ctx.toggleAccounts();
          return;
        }
        if (activeAgentTabIsBusy(state)) {
          e.preventDefault();
          e.stopPropagation();
          void ctx.stopPrompt();
          return;
        }
      }
      // Cmd+= / Cmd++ zoom in. macOS reports `=` for the unshifted key
      // and `+` for shift+=. Match both.
      if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        e.stopPropagation();
        ctx.adjustZoom(0.1);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        ctx.adjustZoom(-0.1);
        return;
      }
      // Cmd+Shift+0: reset zoom (Cmd+0 alone toggles composer ↔
      // terminal focus — more discoverable than reset zoom).
      if (mod && !e.altKey && e.shiftKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        ctx.resetZoom();
        return;
      }
      // Cmd+0: toggle focus between composer and terminal panel.
      if (mod && !e.altKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleFocusComposerTerminal();
        return;
      }
      // Cmd+,: open Settings panel.
      if (mod && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleSettings();
        return;
      }
      // Cmd+L: focus active tab's primary input (composer / shell xterm).
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        ctx.focusActiveContextInput();
        return;
      }
      // F11 / Cmd+Ctrl+F: toggle window fullscreen.
      if (e.key === "F11") {
        e.preventDefault();
        e.stopPropagation();
        invoke("toggle_fullscreen").catch((err: unknown) => {
          console.warn("toggle_fullscreen failed:", err);
        });
        return;
      }
      if (
        mod &&
        e.ctrlKey &&
        e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        e.stopPropagation();
        invoke("toggle_fullscreen").catch((err: unknown) => {
          console.warn("toggle_fullscreen failed:", err);
        });
        return;
      }
      // Cmd+Shift+A: toggle Accounts panel.
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopPropagation();
        ctx.toggleAccounts();
        return;
      }
      // Cmd+Shift+S: export active agent chat as Markdown.
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void ctx.exportActiveChatMarkdown();
        return;
      }
      // F12: toggle WebKit DevTools (debug builds only).
      if (e.key === "F12") {
        e.preventDefault();
        e.stopPropagation();
        invoke("toggle_devtools").catch((err: unknown) => {
          ctx.pushNotification({
            id: "ae-devtools-unavailable",
            title: "DevTools unavailable",
            message: err instanceof Error ? err.message : String(err),
            kind: "info",
            durationMs: 2000,
          });
        });
        return;
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // ctx callbacks are read inside `onKey`; the hook is mounted once
    // with a stable ctx for App's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
