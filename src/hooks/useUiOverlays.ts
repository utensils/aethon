import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../types/tab";
import type {
  PaletteItem,
  PaletteMode,
} from "../skills/default-layout/palette-items";
import { clearConfigCache, getConfig, type AethonConfig } from "../config";
import type { SlashCommand } from "../slashCommands";
import type { NotificationInput } from "./useNotifications";

export interface UseUiOverlaysContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** Apply a freshly-read AethonConfig into the live refs + theme/font
   *  CSS. Settings save calls this after `clearConfigCache()` +
   *  `getConfig()`. */
  reapplyConfig: (fresh: AethonConfig) => void;
  /** Surface settings save success/failure. */
  pushNotification: (n: NotificationInput) => string;

  // ─── Palette dispatch dependencies ──────────────────────────────────
  setActiveTab: (tabId: string) => void;
  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
    },
  ) => void;
  /** Open (or focus) an editor tab for the file path — used by the
   *  palette's "files" mode (Cmd+P selection). */
  newEditorTab: (filePath: string) => void;
  setActiveProjectById: (id: string) => boolean;
  openProjectFromPicker: () => Promise<string | null>;
  closeTab: (tabId: string) => void;
  nextTab: (direction: 1 | -1) => void;
  toggleTerminalAndFocus: () => void;
  toggleFocusComposerTerminal: () => void;
  clearChat: () => void;
  stopPrompt: () => Promise<void>;
  adjustZoom: (delta: number) => void;
  resetZoom: () => void;
  setTheme: (id: string) => void;
  setModel: (id: string) => Promise<void>;
  activateLayoutById: (id: string) => boolean;
  sendChat: (text: string) => Promise<void>;
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  /** Build the live SlashCommandContext used by /palette slash items.
   *  Built per-invocation so handlers see fresh state without re-creating
   *  the command registry. */
  slashContext: () => Parameters<SlashCommand["run"]>[1];
}

export interface UseUiOverlaysActions {
  // ─── Settings ───────────────────────────────────────────────────────
  toggleSettings: () => void;
  closeSettings: () => void;
  applySettingsPatch: (
    patch: Partial<{
      ui: unknown;
      agent: unknown;
      shell: unknown;
      shortcuts: unknown;
    }>,
  ) => void;
  saveSettings: () => Promise<void>;

  // ─── Session search ────────────────────────────────────────────────
  toggleSessionSearch: () => void;
  closeSessionSearch: () => void;
  setSearchQuery: (value: string) => void;
  setSearchScope: (scope: "all" | "current") => void;
  openSearchHit: (hit: { tabId?: string; snippetMatch?: string }) => void;

  // ─── Command palette ───────────────────────────────────────────────
  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  runPaletteItem: (item: PaletteItem) => Promise<void>;
}

/**
 * Three modal/overlay surfaces that render at App root over every
 * layout: command palette (Cmd+P / Cmd+Shift+P), settings panel
 * (Cmd+,), and cross-session search (Cmd+Shift+F). Each owns its
 * open/close/setters and exposes them for the dispatch ctx.
 *
 * Settings save composes a full config from (live snapshot + pending
 * overlay), invokes `write_config`, then re-primes the in-memory cache
 * via `reapplyConfig` so the running app picks up the new values
 * without a page reload.
 *
 * Palette dispatch routes the serializable item.payload to the right
 * App helper — kept here so the palette component itself stays a pure
 * renderer.
 */
export function useUiOverlays(
  ctx: UseUiOverlaysContext,
): UseUiOverlaysActions {
  const {
    setState,
    stateRef,
    reapplyConfig,
    pushNotification,
    setActiveTab,
    newTab,
    newEditorTab,
    setActiveProjectById,
    openProjectFromPicker,
    closeTab,
    nextTab,
    toggleTerminalAndFocus,
    toggleFocusComposerTerminal,
    clearChat,
    stopPrompt,
    adjustZoom,
    resetZoom,
    setTheme,
    setModel,
    activateLayoutById,
    sendChat,
    slashCommandsRef,
    slashContext,
  } = ctx;

  // ─── Settings ─────────────────────────────────────────────────────────

  /** Toggle the Settings panel (M6 P3). Loads the on-disk config on
   *  open via `getConfig()`, exposes form bindings via the
   *  `/settings/pending` slice, and writes back via the
   *  `write_config` Tauri command on Save. */
  function toggleSettings() {
    setState((prev) => {
      const cur = (prev.settings as { open?: boolean } | undefined) ?? {};
      return {
        ...prev,
        settings: { open: !cur.open, pending: null },
      };
    });
  }
  function closeSettings() {
    setState((prev) => ({
      ...prev,
      settings: { open: false, pending: null },
    }));
  }
  /** Apply a partial AethonConfig patch to `/settings/pending`. The
   *  panel form binds to `pending` (overlaid on the live snapshot)
   *  so the user sees changes immediately; Save commits them. */
  function applySettingsPatch(
    patch: Partial<{
      ui: unknown;
      agent: unknown;
      shell: unknown;
      shortcuts: unknown;
    }>,
  ) {
    setState((prev) => {
      const cur = (prev.settings as { open?: boolean; pending?: Record<string, unknown> | null } | undefined) ?? {};
      const merged = { ...(cur.pending ?? {}), ...patch };
      return {
        ...prev,
        settings: { open: !!cur.open, pending: merged },
      };
    });
  }
  /** Save the pending settings: compose a full config object (live
   *  snapshot + pending overlay), invoke `write_config`, then close
   *  the panel and re-prime the in-memory `getConfig()` cache so
   *  subsequent reads pick up the new values. */
  async function saveSettings() {
    const cur = (stateRef.current.settings as
      | { open?: boolean; pending?: Record<string, unknown> | null }
      | undefined) ?? {};
    const pending = cur.pending ?? {};
    let live: AethonConfig | null = null;
    try {
      live = await getConfig();
    } catch (err) {
      console.warn("settings save: getConfig failed:", err);
    }
    const merged = {
      ui: { ...(live?.ui ?? {}), ...((pending as { ui?: object }).ui ?? {}) },
      agent: {
        ...(live?.agent ?? {}),
        ...((pending as { agent?: object }).agent ?? {}),
      },
      shell: {
        ...(live?.shell ?? {}),
        ...((pending as { shell?: object }).shell ?? {}),
      },
      // Always include `shortcuts` so `[shortcuts] new_tab_kind` survives
      // any other Settings save. write_config drops sections it doesn't
      // see — without this, saving Theme would silently revert a
      // previously-saved shortcut to the default.
      shortcuts: {
        ...(live?.shortcuts ?? {}),
        ...((pending as { shortcuts?: object }).shortcuts ?? {}),
      },
    };
    try {
      await invoke("write_config", { config: merged });
      // Drop the in-memory cache and re-read so the running app picks
      // up theme / font / ref-tracked defaults without a page reload.
      clearConfigCache();
      try {
        const fresh = await getConfig();
        reapplyConfig(fresh);
      } catch (err) {
        console.warn("settings save: re-read failed:", err);
      }
      pushNotification({
        id: "ae-settings-saved",
        title: "Settings saved",
        kind: "success",
        durationMs: 2000,
      });
    } catch (err) {
      pushNotification({
        id: "ae-settings-save-failed",
        title: "Failed to save settings",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
        durationMs: 4000,
      });
      return;
    }
    closeSettings();
  }

  // ─── Session search ───────────────────────────────────────────────────

  /** Toggle the cross-session search overlay (M6 P6). State lives at
   *  `/search`; the SearchPanel composite reads `open` + `query` and
   *  invokes `search_sessions` Tauri command on every (debounced)
   *  keystroke. */
  function toggleSessionSearch() {
    setState((prev) => {
      const cur = (prev.search as
        | { open?: boolean; scope?: "all" | "current" }
        | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !cur.open,
          query: "",
          scope: cur.scope ?? "all",
        },
      };
    });
  }
  function closeSessionSearch() {
    setState((prev) => {
      const cur = (prev.search as
        | { scope?: "all" | "current" }
        | undefined) ?? {};
      return {
        ...prev,
        search: { open: false, query: "", scope: cur.scope ?? "all" },
      };
    });
  }
  function setSearchQuery(value: string) {
    setState((prev) => {
      const cur = (prev.search as
        | { open?: boolean; scope?: "all" | "current" }
        | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !!cur.open,
          query: value,
          scope: cur.scope ?? "all",
        },
      };
    });
  }
  function setSearchScope(scope: "all" | "current") {
    setState((prev) => {
      const cur = (prev.search as
        | { open?: boolean; query?: string }
        | undefined) ?? {};
      return {
        ...prev,
        search: {
          open: !!cur.open,
          query: cur.query ?? "",
          scope,
        },
      };
    });
  }
  function openSearchHit(hit: { tabId?: string; snippetMatch?: string }) {
    if (!hit?.tabId) return;
    closeSessionSearch();
    // If a tab with this id is already in /tabs, just activate it +
    // forward the scroll target. Pushing a new tab record with a
    // duplicate id breaks React keys and confuses subsequent updateTab
    // / closeTab lookups (codex finding on PR #26).
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const existing = tabs.find((t) => t.id === hit.tabId);
    if (existing) {
      setActiveTab(existing.id);
      if (typeof hit.snippetMatch === "string" && hit.snippetMatch.length > 0) {
        const id = existing.id;
        const match = hit.snippetMatch;
        setState((prev) => {
          const cur =
            (prev.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
          return {
            ...prev,
            scrollToMatchByTab: { ...cur, [id]: match },
          };
        });
        window.setTimeout(() => {
          setState((prev) => {
            const cur =
              (prev.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
            if (!(id in cur)) return prev;
            const next = { ...cur };
            delete next[id];
            return { ...prev, scrollToMatchByTab: next };
          });
        }, 5000);
      }
      return;
    }
    // Reopen the originating tab. SessionManager.continueRecent picks
    // up the persisted JSONL session under ~/.aethon/sessions/<tabId>/
    // so the user lands inside their previous conversation.
    newTab(hit.tabId, undefined, {
      restoredSession: true,
      ...(typeof hit.snippetMatch === "string" && hit.snippetMatch.length > 0
        ? { scrollToMatch: hit.snippetMatch }
        : {}),
    });
  }

  // ─── Command palette ─────────────────────────────────────────────────

  function openPalette(mode: PaletteMode) {
    setState((prev) => {
      const nextPalette: Record<string, unknown> = {
        ...((prev.palette as Record<string, unknown> | undefined) ?? {}),
        open: true,
        mode,
        query: "",
        selectedIndex: 0,
      };
      // Clear stale files from a previous project when entering files
      // mode — without this, the palette flashes the OLD project's
      // entries while the new walk is in flight (or forever if no
      // project is active and the walk never fires). Once the walk
      // resolves, the same handler writes the fresh list.
      if (mode === "files") {
        nextPalette.files = [];
        nextPalette.projectPath = null;
      }
      return { ...prev, palette: nextPalette };
    });
    // VSCode-style file fuzzy search: when "files" mode opens, kick off
    // a project walk and stash the results in state. The palette
    // selector picks them up on the next render. Cheap when the
    // results are cached (no recent project change) — the walk Rust
    // side is ~50ms on a 5k-file repo, ~150ms on 20k.
    if (mode === "files") {
      const project = stateRef.current.project as { path?: string } | undefined;
      const root = project?.path ?? "";
      if (!root) return;
      void invoke<string[]>("fs_walk_project", { root })
        .then((paths) => {
          // Project may have changed while the walk was in flight —
          // discard so we never show files from a stale root. The user
          // re-triggering Cmd+P refires the walk against the current
          // project, so this is just a "don't poison the palette"
          // guard, not a retry.
          const current = (stateRef.current.project as { path?: string } | undefined)
            ?.path ?? "";
          if (current !== root) return;
          const normalized = root.replace(/\/+$/, "");
          const files = paths.map((path) => {
            const rel = path.startsWith(normalized + "/")
              ? path.slice(normalized.length + 1)
              : path;
            return { path, rel };
          });
          setState((prev) => ({
            ...prev,
            palette: { ...(prev.palette ?? {}), files, projectPath: root },
          }));
        })
        .catch(() => {
          /* ignore — palette falls back to empty file list */
        });
    }
  }
  function closePalette() {
    setState((prev) => ({
      ...prev,
      palette: { ...(prev.palette ?? {}), open: false, query: "", selectedIndex: 0 },
    }));
  }
  // Route a palette selection to the right handler. The palette emits
  // serializable payloads only; we resolve them against App helpers
  // here so the component stays a pure renderer.
  async function runPaletteItem(item: PaletteItem) {
    const p = item.payload;
    switch (p.kind) {
      case "tab":
        setActiveTab(p.tabId);
        return;
      case "session":
        newTab(p.sessionId, p.label, {
          restoredSession: true,
          ...(p.cwd ? { cwd: p.cwd } : {}),
        });
        return;
      case "project":
        setActiveProjectById(p.projectId);
        return;
      case "open-project":
        openProjectFromPicker();
        return;
      case "slash": {
        // Reuse the same path the chat composer takes. Wraps the slash
        // run with the live ctx so handlers see fresh state. Failures
        // surface as a toast so the user sees what went wrong without
        // a chat-history breadcrumb.
        const cmd = slashCommandsRef.current.find((c) => c.name === p.name);
        if (!cmd) {
          pushNotification({
            title: `Unknown command /${p.name}`,
            kind: "error",
          });
          return;
        }
        try {
          if (cmd.passthroughToAgent) {
            const args = p.args ? ` ${p.args}` : "";
            await sendChat(`/${p.name}${args}`);
            return;
          }
          await cmd.run(p.args ?? "", slashContext());
        } catch (err) {
          pushNotification({
            title: `/${p.name} failed`,
            message: String(err),
            kind: "error",
          });
        }
        return;
      }
      case "keybinding": {
        // Same dispatch shape the global keydown handler uses. Lets a
        // paired aethon.onEvent matcher fire as if the user had hit
        // the key.
        invoke("dispatch_a2ui_event", {
          event: JSON.stringify({
            componentId: `keybinding__tpl__${p.combo}`,
            componentType: "keybinding",
            templateRootType: "keybinding",
            eventType: "invoke",
            data: { combo: p.combo, action: p.action },
          }),
          tabId: stateRef.current.activeTabId,
        }).catch(() => {
          /* ignore — bridge gone */
        });
        return;
      }
      case "layout":
        activateLayoutById(p.layoutId);
        return;
      case "theme":
        setTheme(p.themeId);
        return;
      case "model":
        await setModel(p.modelId);
        return;
      case "action":
        // Built-in action strings from BUILTIN_KEYBINDINGS — fire the
        // same path the keydown clauses do so palette-triggered actions
        // are indistinguishable from key-triggered ones.
        if (p.action === "builtin:meta+t") newTab();
        else if (p.action === "builtin:meta+w") {
          const id = stateRef.current.activeTabId as string | undefined;
          if (id) closeTab(id);
        } else if (p.action === "builtin:meta+shift+]") nextTab(1);
        else if (p.action === "builtin:meta+shift+[") nextTab(-1);
        else if (p.action === "builtin:meta+`") toggleTerminalAndFocus();
        else if (p.action === "builtin:meta+0") toggleFocusComposerTerminal();
        else if (p.action === "builtin:meta+k") clearChat();
        else if (p.action === "builtin:meta+.") void stopPrompt();
        else if (p.action === "builtin:meta+p") openPalette("files");
        else if (p.action === "builtin:meta+shift+p") openPalette("commands");
        else if (p.action === "builtin:meta+=") adjustZoom(0.1);
        else if (p.action === "builtin:meta+-") adjustZoom(-0.1);
        else if (p.action === "builtin:meta+shift+0") resetZoom();
        return;
      case "file":
        // VSCode-style Cmd+P selection — open the file in an editor
        // tab (focuses an existing one if already open).
        newEditorTab(p.filePath);
        return;
    }
  }

  return {
    toggleSettings,
    closeSettings,
    applySettingsPatch,
    saveSettings,
    toggleSessionSearch,
    closeSessionSearch,
    setSearchQuery,
    setSearchScope,
    openSearchHit,
    openPalette,
    closePalette,
    runPaletteItem,
  };
}
