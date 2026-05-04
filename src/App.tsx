import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import A2UIRenderer, { RegistryComponent } from "./components/A2UIRenderer";
import { SkillRegistry } from "./skills/SkillRegistry";
import { SkillRegistryProvider } from "./skills/registry";
import {
  defaultLayoutSkill,
} from "./skills/default-layout";
import type {
  PaletteItem,
  PaletteMode,
} from "./skills/default-layout/palette-items";
import type {
  NotificationEntry,
  NotificationKind,
} from "./skills/default-layout/notifications";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import {
  NO_PROJECT_KEY,
  makeEmptyTab,
  projectBucketKey,
  type ShellMeta,
  type Tab,
} from "./types/tab";
import { dispatchEvent, type EventRouteContext } from "./eventRoutes";
import { shellQuoteAll } from "./utils/shellQuote";
import { applyUiScale } from "./utils/viewport";
import { formatRelativeTime } from "./utils/time";
import { useZoomAndTheme } from "./hooks/useZoomAndTheme";
import { useShellConsent } from "./hooks/useShellConsent";
import { useProjects } from "./hooks/useProjects";
import { useTabNavigation } from "./hooks/useTabNavigation";
import { useTabs, TAB_MIRROR_KEYS, TERMINAL_REPLAY_MAX } from "./hooks/useTabs";
import { useExtensionsHydration } from "./hooks/useExtensionsHydration";
import { useBridgeMessages } from "./hooks/useBridgeMessages";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWindowApi } from "./runtime/windowApi";
import { isFocusInTerminalPanel } from "./utils/focus";
import {
  parseSlashCommand,
  type SlashCommandContext,
} from "./slashCommands";
import {
  readStateWithLocalStorageFallback,
  writeState,
} from "./persist";
import { clearConfigCache, getConfig, type AethonConfig } from "./config";
import {
  activeProject,
  emptyProjectsState,
  loadProjects,
  pickProjectDirectory,
  removeProject,
  saveProjects,
  upsertProject,
  type ProjectsState,
} from "./projects";
// Vite resolves `?url` imports to a hashed asset URL at build time. Injecting
// the URL into layout state lets the header bind via `{"$ref": "/logoUrl"}`
// instead of hardcoding a path that might 404 in a production bundle.
import logoUrl from "./assets/aethon-logo.svg?url";

// The default-layout skill ships a layout — that's the boot payload.
const BOOT_LAYOUT: A2UIPayload = defaultLayoutSkill.layout!;

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  /** First user message text, trimmed to 60 chars by the bridge. Used to
   *  label sidebar history items meaningfully instead of UUID slices. */
  firstUserMessage?: string;
}

interface SidebarHistoryItem {
  id: string;
  label: string;
  hint?: string;
  tooltip?: string;
  active?: boolean;
}

export default function App() {
  // The registry is created once and shared across the app via context.
  // Skills register their components/layouts here; the renderer resolves
  // unknown component types through it.
  const registryRef = useRef<SkillRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new SkillRegistry();
    registryRef.current.register(defaultLayoutSkill);
  }
  const registry = registryRef.current;

  // ---------------------------------------------------------------------
  // Multi-tab model. Each tab owns its own `messages`, `draft`, `waiting`,
  // `queueCount`, and `canvas`. The active tab's view is mirrored to the
  // top-level state keys (`/messages`, `/draft`, etc.) so the existing
  // layout JSON bindings keep working without a per-tab JSON Pointer
  // rewrite. On tab switch we re-mirror the new active tab's view; on
  // every per-tab update we write the tab record AND, if it's active,
  // also write the root mirror. Tab/ShellMeta types live in
  // src/types/tab.ts.
  // ---------------------------------------------------------------------
  const buildSidebarHistory = useCallback((
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: RecentSessionItem[],
  ): SidebarHistoryItem[] => {
    const openIds = new Set(tabs.map((t) => t.id));
    const firstUserText = (messages: ChatMessage[]): string => {
      const first = messages.find(
        (m) => m.role === "user" && typeof m.text === "string" && m.text.trim().length > 0,
      );
      return first?.text?.replace(/\s+/g, " ").trim().slice(0, 48) ?? "";
    };
    const openHistory = tabs
      .filter((t) => t.messages.length > 0)
      .map((t) => {
        const firstMsg = firstUserText(t.messages);
        // Use first user message as the display label when the tab still has
        // a generic sequential name (Tab 1, Tab 2, …). Explicit renames keep
        // their name.
        const label = /^Tab \d+$/.test(t.label) && firstMsg ? firstMsg : t.label;
        const hint = t.id === activeTabId ? "active" : `${t.messages.length} msg`;
        return {
          id: `tab:${t.id}`,
          label,
          hint,
          tooltip: firstMsg || label,
          active: t.id === activeTabId,
        };
      });
    const restoredHistory = recentSessions
      .filter((s) => !openIds.has(s.id))
      .map((s) => ({
        id: `session:${s.id}`,
        label: s.label,
        hint: s.lastModified,
        tooltip: s.cwd ? s.cwd : "Restore session",
      }));
    return [...openHistory, ...restoredHistory].slice(0, 16);
  }, []);

  function normalizeSessionPath(path: string | undefined): string {
    return (path ?? "").replace(/[/\\]+$/, "");
  }

  function scopedDiscoveredSessions(
    discovered: DiscoveredSession[],
  ): DiscoveredSession[] {
    const active = activeProject(projectsRef.current);
    if (!active) return discovered;
    const activePath = normalizeSessionPath(active.path);
    return discovered.filter((session) => normalizeSessionPath(session.cwd) === activePath);
  }

  function knownTabIds(extraTabs: { id: string }[] = []): Set<string> {
    return new Set(
      (((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => t.id))
        .concat(extraTabs.map((t) => t.id))
        .concat(["default"]),
    );
  }

  function recentSessionItems(
    discovered: DiscoveredSession[],
    openIds: Set<string>,
  ): RecentSessionItem[] {
    return discovered
      .filter((d) => !openIds.has(d.tabId))
      .slice(0, 8)
      .map((d) => {
        // Derive a human-readable label in priority order:
        //   1. First user message text (most descriptive)
        //   2. Project directory basename
        //   3. Fallback UUID prefix
        const cwdBasename = d.cwd
          ? d.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
          : "";
        const label = d.firstUserMessage
          ? d.firstUserMessage.replace(/\s+/g, " ").trim()
          : cwdBasename || `Session ${d.tabId.slice(0, 8)}`;
        return {
          id: d.tabId,
          label,
          lastModified: formatRelativeTime(d.lastModified),
          ...(d.cwd ? { cwd: d.cwd } : {}),
        };
      });
  }

  function syncRecentSessionsToState() {
    const sessions = recentSessionItems(
      scopedDiscoveredSessions(allDiscoveredSessionsRef.current),
      knownTabIds(),
    );
    setState((prev) => ({ ...prev, recentSessions: sessions }));
  }
  // The layout's state IS the app state. Single source of truth, addressed by
  // JSON Pointer from the layout payload. We seed `logoUrl` here so the header
  // can $ref it without the layout JSON having to know the hashed asset path.
  // Initial state also seeds one default tab + the active-tab mirror keys.
  const [state, setState] = useState<Record<string, unknown>>(() => {
    const tab0 = makeEmptyTab("default", "Tab 1");
    return {
      ...(BOOT_LAYOUT.state ?? {}),
      logoUrl,
      // App version surfaced as a state slice so layout JSON can $ref it
      // (e.g. sidebar's `version` prop). Single source of truth is
      // package.json — vite injects __APP_VERSION__ at build time. The
      // "v" prefix matches the human-friendly format the UI used before.
      appVersion: `v${__APP_VERSION__}`,
      tabs: [tab0],
      activeTabId: tab0.id,
      // Mirror keys point at the active tab's empty view so layout bindings
      // see well-defined values from boot.
      messages: tab0.messages,
      draft: tab0.draft,
      waiting: tab0.waiting,
      queueCount: tab0.queueCount,
      canvas: tab0.canvas,
      // Layout-agnostic UI surfaces — the palette + notification stack
      // both render at App root so they overlay every layout. State
      // shapes are documented on the components themselves.
      palette: { open: false, mode: "switcher", query: "", selectedIndex: 0 },
      notifications: [],
      // Seed /sidebar/extensions so the $ref-bound sidebar section renders
      // the built-in entry immediately — hydrateExtensions() fills in
      // dynamically-loaded extensions once `ready` arrives.
      sidebar: {
        ...(BOOT_LAYOUT.state?.sidebar as Record<string, unknown> | undefined),
        extensions: [
          { id: "extension-layout", label: "default-layout", hint: "core", active: true },
        ],
      },
    };
  });

  // Active layout payload — replaceable. Skills can swap the chrome wholesale
  // by calling window.aethon.setLayout(payload), or register a new skill via
  // window.aethon.registerSkill(skill) and switch to its layout.
  const [layout, setLayout] = useState<A2UIPayload>(BOOT_LAYOUT);

  // Fallback id for text bubbles when the bridge doesn't supply one. The
  // bridge now sends a stable `messageId` per pi assistant message so text
  // deltas after a tool card still land in the original bubble; this ref
  // only matters for old-bridge / legacy `response_delta` payloads.
  const activeResponseIdRef = useRef<string | null>(null);
  // autoRestoredSessionIdsRef now lives in useTabs (the hook owns
  // restore-tab dedup). Other tab refs likewise.
  const allDiscoveredSessionsRef = useRef<DiscoveredSession[]>([]);
  const projectsLoadedRef = useRef(false);
  // Projects (working directories the agent operates in). Persisted to
  // ~/.aethon/projects.json. The active project's path travels with each
  // new tab as `cwd` on `tab_open` so pi's SessionManager scopes the
  // session to that directory. Existing tabs keep their original cwd —
  // switching project doesn't retroactively change live sessions.
  const projectsRef = useRef<ProjectsState>(emptyProjectsState());
  // Pi's default model from the last `ready` event. Used to seed new tabs
  // before ready fires (or when the active tab has no model yet), so the
  // picker never shows a blank "model ▼" label.
  const piDefaultModelRef = useRef<string>("");

  // Themes — three built-in palettes (ember/paper/aether) plus
  // extension-registered ones. Persisted to `~/.aethon/theme` so the choice
  // survives reloads. Resolution priority: per-session disk file →
  // config.toml `[ui] theme` → OS `prefers-color-scheme` (light → paper,
  // dark → ember) → ember. Migrates the legacy `aethon-theme` localStorage
  // entry on first read; the previous `signature` id maps to `aether`.
  //
  // Extension themes are kept in a ref (not React state) so injectThemeStyle
  // can apply CSS imperatively without re-rendering and `setTheme` can look
  // up an id without a stale closure. The sidebar items list lives in
  // `/sidebar/themes` (see hydrateThemes below) so the existing $ref-bound
  // sidebar item path picks them up.
  // [shell] default_share_mode resolved from ~/.aethon/config.toml. Read
  // once on boot (see the getConfig() effect below) and consulted by
  // newShellTab. Defaults to `"private"` until the config loads — the
  // safest possible seed for new shell tabs.
  const defaultShareModeRef = useRef<ShellMeta["shareMode"]>("private");
  // P4: per-tab turn start timestamps. Set on `prompt_started`, cleared
  // on `response_end`. Used to compute turn duration for the OS
  // completion notification gate.
  const turnStartedAtRef = useRef<Map<string, number>>(new Map());
  // Hang-warn: useBridgeMessages owns the timer scheduling + notification
  // id. We expose these refs so the agent-reloaded / agent-crashed paths
  // can clear timers + dismiss any pending warnings on supervisor signals.
  const hangWarnNotifId = (tabId: string) => `ae-hang-warn:${tabId}`;
  const hangWarnActiveRef = useRef<Set<string>>(new Set());
  const hangWarnTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // P4: live config for OS notifications. Mirrors `config.ui.notifyOnCompletion`
  // / `notifyMinDurationSeconds` and is updated in the boot config effect.
  // Held in a ref (not state) so the response_end handler reads the
  // latest value without re-binding.
  const notifyOnCompletionRef = useRef<boolean>(true);
  const notifyMinDurationMsRef = useRef<number>(8 * 1000);
  // P5: live config for [shell] auto_restart_agent. Read by the
  // `agent-crashed` listener.
  const autoRestartAgentRef = useRef<boolean>(true);
  // [shell] default_command / default_args / inherit_env / prompt_before_close —
  // applied at shell_open time. Defaults track the helpers.rs schema so the
  // first paint behaves identically to a fully-loaded config.
  const shellDefaultCommandRef = useRef<string | null>(null);
  const shellDefaultArgsRef = useRef<string[]>([]);
  const shellInheritEnvRef = useRef<boolean>(true);
  const shellPromptBeforeCloseRef = useRef<boolean>(true);
  // [shortcuts] new_tab_kind — controls Cmd+T routing when focus is
  // outside the bottom terminal panel. "agent" (default) → new agent
  // tab, "shell" → always open a shell sub-tab.
  const shortcutsNewTabKindRef = useRef<"agent" | "shell">("agent");
  // Built-in themes always available. CSS for these lives in styles.css —
  // we don't inject a <style> tag for them.

  // Inject (or replace) the <style> element holding an extension theme's
  // CSS custom properties. Keyed by id so re-registering replaces the
  // previous rule rather than stacking. Values are written via CSSOM
  // `setProperty` (not string interpolation) so a malformed value
  // containing `;` or `}` can't escape the declaration and inject
  // arbitrary rules — the parser silently rejects invalid values
  // instead of letting them leak into the stylesheet.

  // Apply a fresh themes list — replace the registry, inject CSS for each,
  // and mirror id/label pairs to /sidebar/themes so the sidebar updates.
  // Style tags whose ids no longer appear in the list are removed first so
  // a deleted/disabled extension stops bleeding stale CSS into the page.

  // Hydrate the sidebar extensions list from the bridge's loaded/failed sets.
  // Called on `ready` (startup + project switch) so the list always reflects
  // what the current bridge process has actually loaded.


  useEffect(() => {
    (async () => {
      const [saved, config] = await Promise.all([
        readStateWithLocalStorageFallback("theme", "aethon-theme"),
        getConfig(),
      ]);
      const trimmed = saved.trim();
      // Migrate legacy theme ids:
      //   - `signature` (one-theme era) → `aether`
      //   - `dark` (pre-palette-rename) → `ember`
      //   - `light` (pre-palette-rename) → `paper`
      // Without this, a saved id from an older build resolves to a
      // `data-theme="dark"` selector that no stylesheet defines, so the
      // app falls back to base ember tokens regardless of the user's
      // actual choice.
      const LEGACY_THEME_MAP: Record<string, string> = {
        signature: "aether",
        dark: "ember",
        light: "paper",
      };
      const normalize = (id: string) => LEGACY_THEME_MAP[id] ?? id;
      const prefersLight =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: light)").matches;
      const initial =
        trimmed.length > 0
          ? normalize(trimmed)
          : config.ui.theme
            ? normalize(config.ui.theme)
            : prefersLight
              ? "paper"
              : "ember";
      document.documentElement.dataset.theme = initial;
      // Apply [ui] font_size as a CSS custom property — components that
      // care can read it via var(--app-font-size, 14px). Clamped to a
      // sensible range so a malformed config can't make the UI
      // unreadable. Skipped when null so the stylesheet's default wins.
      const size = config.ui.fontSize;
      if (typeof size === "number" && Number.isFinite(size)) {
        const clamped = Math.max(10, Math.min(24, Math.round(size)));
        document.documentElement.style.setProperty(
          "--app-font-size",
          `${clamped}px`,
        );
      }
      // [shell] default_share_mode: seed the ref so subsequent
      // newShellTab calls open with the configured default. Already
      // clamped to the four valid modes by getConfig() / parse_config_toml.
      defaultShareModeRef.current = config.shell.defaultShareMode;

      // P4: notify_on_completion + notify_min_duration_seconds.
      notifyOnCompletionRef.current = config.ui.notifyOnCompletion;
      notifyMinDurationMsRef.current =
        Math.max(0, config.ui.notifyMinDurationSeconds) * 1000;
      // P5: [shell] auto_restart_agent.
      autoRestartAgentRef.current = config.shell.autoRestartAgent;
      // Extended [shell] keys.
      shellDefaultCommandRef.current = config.shell.defaultCommand;
      shellDefaultArgsRef.current = config.shell.defaultArgs;
      shellInheritEnvRef.current = config.shell.inheritEnv;
      shellPromptBeforeCloseRef.current = config.shell.promptBeforeClose;
      // [shortcuts] new_tab_kind.
      shortcutsNewTabKindRef.current = config.shortcuts.newTabKind;

      // [agent] model: when set, seed the picker default for this
      // session. Only applied if no per-session model has been saved
      // and the bridge hasn't already locked one in. The bridge's
      // ensureTab() reads the global picker default at session-create
      // time, so writing /model here makes the next set_model dispatch
      // pick it up.
      if (config.agent.model) {
        setState((prev) => ({
          ...prev,
          // Use as the initial display value; the actual session model
          // is still authoritative and wins on `ready` hydration.
          model: (prev.model) || config.agent.model!,
        }));
      }
      // Restore saved UI zoom (Cmd+/-). Stored as a string number on
      // disk; clamp to a sensible range so a stale value can't make
      // the UI unusable. applyUiScale writes both CSS zoom and the
      // --app-ui-scale token that viewport-sized containers use to
      // compensate, so zooming does not push chrome outside the window.
      const savedZoom = (
        await readStateWithLocalStorageFallback("ui_zoom", "")
      ).trim();
      const z = parseFloat(savedZoom);
      if (Number.isFinite(z) && z >= 0.7 && z <= 1.6) {
        applyUiScale(z);
      }
      // Restore saved sidebar width: patch the leading column token in
      // /layout/columns so the boot layout opens at the user's last
      // chosen width. Bail on missing/invalid values — the layout's
      // own seed wins by default.
      const savedWidth = (
        await readStateWithLocalStorageFallback("sidebar_width", "")
      ).trim();
      const px = parseInt(savedWidth, 10);
      if (Number.isFinite(px) && px >= 180 && px <= 540) {
        setState((prev) => {
          const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
          const current = (layout.columns as string | undefined) ?? "";
          if (!current) return prev;
          const tokens = current.trim().split(/\s+/);
          if (!tokens[0]?.endsWith("px")) return prev;
          tokens[0] = `${px}px`;
          return { ...prev, layout: { ...layout, columns: tokens.join(" ") } };
        });
      }
    })();
  }, []);

  // ---------------------------------------------------------------------
  // UI zoom + theme switching are owned by useZoomAndTheme. The hook
  // also installs a window resize listener that re-syncs the viewport
  // CSS vars so layout-sized children stay aligned at non-1.0 zoom.
  // ---------------------------------------------------------------------
  const { adjustZoom, resetZoom, setTheme } = useZoomAndTheme({
    setState,
    pushNotification,
  });

  // Chat history is now persisted exclusively via pi's JSONL session files
  // under $AETHON_SESSIONS_DIR/<tabId>/. On startup the bridge emits a
  // `session_history` event for every tab (including "default") so all tabs
  // use the same restore path — no separate messages.json needed.

  function clearChat() {
    // Clears the active tab's in-memory message list. Pi's JSONL file is
    // managed by the session itself; clearing chat here only affects the UI
    // view for this session slot. The agent will continue writing new turns
    // to the same session file, so a restart still sees prior history — this
    // is intentional (Cmd+K is a "clean view" action, not a "delete history"
    // action). If the user wants to start fresh, they open a new tab.
    updateActiveTab((tab) => ({ ...tab, messages: [] }));
  }

  function toggleTerminal() {
    setState((prev) => {
      const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
      return { ...prev, terminal: { ...term, open: !term.open } };
    });
  }

  /** Toggle the terminal panel AND move focus to/from it.
   *
   *  Open + focus: pulls focus into the active sub-tab's terminal
   *  (xterm has a `.focus()` method exposed via the live DOM).
   *  Close + return-focus: drops focus back to the chat composer so
   *  typing continues seamlessly. Without this users have to re-click
   *  to refocus after every panel toggle. */
  function toggleTerminalAndFocus() {
    const wasOpen = !!(stateRef.current.terminal as { open?: boolean } | undefined)?.open;
    toggleTerminal();
    // Defer focus until after React has committed the render so the
    // panel's xterm canvas exists in the DOM.
    requestAnimationFrame(() => {
      if (wasOpen) {
        focusComposer();
      } else {
        focusTerminalPanel();
      }
    });
  }

  /** Cmd+0: toggle focus between the chat composer and the bottom
   *  terminal panel. If the panel is closed, opens it first. */
  function toggleFocusComposerTerminal() {
    const inPanel = isFocusInTerminalPanel();
    if (inPanel) {
      focusComposer();
      return;
    }
    const term = (stateRef.current.terminal as { open?: boolean } | undefined) ?? {};
    if (!term.open) {
      // Open first, then focus on the next frame.
      setState((prev) => {
        const t = (prev.terminal as { open?: boolean } | undefined) ?? {};
        return { ...prev, terminal: { ...t, open: true } };
      });
    }
    requestAnimationFrame(() => focusTerminalPanel());
  }

  /** Cmd+L: focus the active tab's primary input. Agent tab → chat
   *  composer, shell tab → that shell's xterm. The bottom terminal
   *  panel is opened first when needed so the focus call has a target
   *  to land on. */
  function focusActiveContextInput() {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
    if (tab?.kind === "shell") {
      const term =
        (stateRef.current.terminal as { open?: boolean } | undefined) ?? {};
      if (!term.open) {
        setState((prev) => {
          const t = (prev.terminal as { open?: boolean } | undefined) ?? {};
          return { ...prev, terminal: { ...t, open: true } };
        });
      }
      requestAnimationFrame(() => focusTerminalPanel());
      return;
    }
    focusComposer();
  }

  /** Cmd+Shift+S: export the active agent tab's chat history as a
   *  Markdown file in ~/Downloads/. Shell tabs no-op (no chat
   *  history). The body uses GitHub-flavored Markdown — role labels
   *  as `### user` / `### assistant`, message text as paragraphs. */
  async function exportActiveChatMarkdown() {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
    if (!tab || tab.kind !== "agent") {
      pushNotification({
        id: "ae-export-no-chat",
        title: "Nothing to export",
        message: "Switch to an agent tab to export its chat as Markdown.",
        kind: "info",
        durationMs: 2400,
      });
      return;
    }
    const messages = tab.messages ?? [];
    if (messages.length === 0) {
      pushNotification({
        id: "ae-export-empty",
        title: "Empty chat",
        message: "There are no messages to export yet.",
        kind: "info",
        durationMs: 2400,
      });
      return;
    }
    const body = messages
      .map((m) => {
        const heading = `### ${m.role}`;
        const text = (m.text ?? "").replace(/\r\n/g, "\n").trim();
        return `${heading}\n\n${text}\n`;
      })
      .join("\n");
    const header = `# ${tab.label}\n\n_Exported from Aethon · ${new Date().toISOString()}_\n\n`;
    try {
      const path = await invoke<string>("export_chat_markdown", {
        label: tab.label,
        content: header + body,
      });
      pushNotification({
        id: "ae-export-saved",
        title: "Chat exported",
        message: `Saved to ${path}`,
        kind: "success",
        durationMs: 3000,
      });
    } catch (err) {
      pushNotification({
        id: "ae-export-failed",
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
        durationMs: 4000,
      });
    }
  }

  function focusComposer() {
    if (typeof document === "undefined") return;
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".a2ui-chat-input textarea, .a2ui-chat-input input",
    );
    ta?.focus();
  }

  function focusTerminalPanel() {
    if (typeof document === "undefined") return;
    // xterm renders an inner textarea (`.xterm-helper-textarea`) that
    // it forwards keystrokes to. Focusing it routes typing into the
    // active sub-tab's PTY (or the read-only agent-bash xterm where
    // it's a no-op input but the cursor still indicates focus).
    const panel = document.querySelector(".ae-terminal-panel");
    const helperTa = panel?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (helperTa) {
      helperTa.focus();
      return;
    }
    // Fallback: focus the panel's first focusable element.
    const focusable = panel?.querySelector<HTMLElement>(
      'button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }

  function toggleSidebar() {
    setState((prev) => {
      // Flip /layout/sidebarVisible AND swap /layout/columns +
      // /layout/areas atomically so the grid template adapts on
      // the same frame the sidebar cell hides. Without the
      // template swap the hidden sidebar would still reserve its
      // 220px column. Workstation hoists tabs into the header
      // (5 rows total); future layout variations may own their own
      // area templates and not bind /layout/areas, so this toggle
      // stays workstation-shaped.
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const visible = !((layout.sidebarVisible as boolean | undefined) ?? true);
      const columns = visible ? "220px minmax(0,1fr)" : "minmax(0,1fr)";
      const areas = visible
        ? [
            "sidebar header",
            "sidebar canvas",
            "sidebar terminal",
            "sidebar composer",
            "status status",
          ]
        : ["header", "canvas", "terminal", "composer", "status"];
      return {
        ...prev,
        layout: { ...layout, sidebarVisible: visible, columns, areas },
      };
    });
  }

  async function stopPrompt(explicitTabId?: string) {
    const tabId =
      explicitTabId ?? (stateRef.current.activeTabId as string | undefined) ?? "default";
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "stop", tabId }),
      });
      setStatusFlags({ status: "stopping…" });
    } catch (err) {
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to stop: ${err}`,
        },
        tabId,
      );
    }
  }

  // Shell consent flow (Allow/Deny prompts for agent shell writes,
  // close-shell confirmations, and session deletions) lives in
  // useShellConsent. Each prompt resolves its Promise via an action
  // route handler on the notification. See src/hooks/useShellConsent.ts.
  const {
    resolveShellWriteConsent,
    resolveShellCloseConsent,
    resolveSessionDeleteConsent,
    hasPendingShellWriteConsent,
    hasPendingShellCloseConsent,
    hasPendingSessionDeleteConsent,
    promptShellWriteConfirmation,
    promptCloseShellTabConfirmation,
    promptDeleteSessionConfirmation,
  } = useShellConsent({ pushNotification });

  /** Route an `aethon.shells.write` request through the share-mode gate.
   *  - private / read       → reject (Rust would too; we early-out)
   *  - read-write           → push a confirmation notification with
   *                            Allow / Deny actions. Resolves on click.
   *  - read-write-trusted   → invoke shell_write directly.
   *  Defense-in-depth: the Rust `shell_write` Tauri command re-checks
   *  the mode, so a frontend bug can't bypass the gate. */
  async function routeShellWrite(
    args: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const tabId = String(args.tabId ?? "");
    const text = String(args.text ?? "");
    if (!tabId) throw new Error("tabId required");
    if (text.length === 0) throw new Error("text must be non-empty");
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== "shell" || !tab.shell) {
      throw new Error(`no shell tab with id ${tabId}`);
    }
    const mode = tab.shell.shareMode;
    if (mode === "private" || mode === "read") {
      throw new Error(`share mode "${mode}" does not allow agent writes`);
    }
    if (mode === "read-write-trusted") {
      await invoke("shell_write", { tabId, data: text });
      return { ok: true };
    }
    // read-write: prompt the user and only proceed on Allow.
    const allowed = await promptShellWriteConfirmation({
      tabId,
      text,
      tabLabel: tab.label,
    });
    if (!allowed) {
      throw new Error("user denied agent write");
    }
    await invoke("shell_write", { tabId, data: text });
    return { ok: true };
  }

  // Recompute the global model picker's `active` flag against `model`.
  // Called whenever the active tab changes (switch / new / close) so the
  // sidebar highlight tracks the active session's chosen model. Returns
  // a new sidebar object — caller is responsible for splatting into state.
  function recomputeModelPicker(
    sidebar: Record<string, unknown> | undefined,
    model: string,
  ): Record<string, unknown> {
    const items =
      ((sidebar?.models as { id: string; label: string }[] | undefined) ?? [])
        .map((m) => ({ id: m.id, label: m.label, active: m.id === model }));
    return { ...(sidebar ?? {}), models: items };
  }

  // Latest state, kept in a ref so the aethon-debug skill can read it via
  // `window.__AETHON_STATE__()` without going through React's state lifecycle.
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---------------------------------------------------------------------
  // Extensions hydration: themes, sidebar entries, keybindings, event
  // routes, layouts, frontend modules, slash commands. Each `hydrate*`
  // is a wholesale replacement (every delta from the bridge replaces
  // the prior set). Plus layout activation, layout component summary,
  // and the lastExtensionStateKeysRef pruning ledger.
  // ---------------------------------------------------------------------
  const {
    layoutCatalogueRef,
    extensionEventRoutesRef,
    extensionEventRoutingModeRef,
    extensionKeybindingsRef,
    slashCommandsRef,
    lastExtensionStateKeysRef,
    hydrateThemes,
    hydrateExtensions,
    hydrateEventRoutes,
    hydrateKeybindings,
    hydrateExtensionLayouts,
    hydrateFrontendModules,
    hydrateSlashCommands,
    listThemes,
    activateLayoutById,
  } = useExtensionsHydration({
    setState,
    setLayout,
    stateRef,
    registry,
    appendSystem,
    layout,
  });

  // ---------------------------------------------------------------------
  // Tab lifecycle (create / switch / update / close / undo-close), the
  // sub-tab switcher, the shell-/agent-tab-active mirror effect, and the
  // terminal replay dispatch all live in useTabs. The hook keeps closed-
  // tab + auto-restore + pending-tab-open state internally; the orchestration-
  // level wiring (chat-input dispatch, sidebar history, keyboard
  // shortcuts) stays here and reaches in via the destructured actions.
  // ---------------------------------------------------------------------
  const {
    pendingTabOpens,
    updateTab,
    updateActiveTab,
    applyShareModeToTab,
    dispatchTerminalReplay,
    setActiveTab,
    setActiveSubTab,
    newTab,
    newShellTab,
    autoRestoreDiscoveredSessions,
    reopenLastClosedTab,
    closeTab,
  } = useTabs({
    setState,
    stateRef,
    pushNotification,
    appendSystem,
    promptCloseShellTabConfirmation,
    recomputeModelPicker,
    projectsRef,
    piDefaultModelRef,
    clearActiveProject,
    setActiveProjectById,
    defaultShareModeRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
  });

  // Tab/sub-tab navigation (next/jump/move for both agent tabs and
  // shell sub-tabs) lives in useTabNavigation. The hook computes the
  // target id and delegates to setActiveTab / setActiveSubTab — the
  // heavy lifecycle (state mirroring, terminal replay) stays here.
  const {
    nextTab,
    jumpToTab,
    moveActiveTab,
    nextShellSubTab,
    jumpToShellSubTab,
    moveActiveShellSubTab,
  } = useTabNavigation({ stateRef, setState, setActiveTab, setActiveSubTab });

  // Global keyboard shortcuts. Lives in useKeyboardShortcuts which
  // binds a document-level keydown listener with useCapture so we run
  // before xterm sees the keystroke.
  useKeyboardShortcuts({
    stateRef,
    extensionKeybindingsRef,
    shortcutsNewTabKindRef,
    toggleTerminalAndFocus,
    toggleSidebar,
    clearChat,
    stopPrompt,
    newTab,
    newShellTab,
    nextTab,
    nextShellSubTab,
    moveActiveTab,
    moveActiveShellSubTab,
    jumpToTab,
    jumpToShellSubTab,
    reopenLastClosedTab,
    closeTab,
    toggleSessionSearch,
    openPalette,
    closePalette,
    adjustZoom,
    resetZoom,
    toggleFocusComposerTerminal,
    toggleSettings,
    focusActiveContextInput,
    exportActiveChatMarkdown,
    pushNotification,
  });

  // window.aethon runtime API + dev-only __AETHON_* debug hooks.
  // Lives in src/runtime/windowApi.ts; mounts via useWindowApi.
  useWindowApi({
    layout,
    bootLayout: BOOT_LAYOUT,
    setLayout,
    setState,
    stateRef,
    registry,
    layoutCatalogueRef,
    projectsRef,
    newTab,
    closeTab,
    setActiveTab,
    activateLayoutById,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
  });

  // Mirror an allowlisted set of frontend state slices back to the bridge
  // so extensions can introspect them via `aethon.getFrontendState(path)`.
  // The bridge can otherwise only see values it wrote itself — this closes
  // the loop on frontend-populated keys (model picker, themes, connection,
  // status, tabs, draft, messages count). Debounced via a microtask + diff
  // so a flurry of state changes (typing into the composer) coalesces into
  // a single ack-bearing patch per slice.
  const lastFrontendStateRef = useRef<Record<string, string>>({});
  // Per-frame coalesce timer. Each state change reschedules; the IPC
  // burst only fires once the user stops mutating state for a tick. This
  // matters most when typing into the composer — without the debounce,
  // every keystroke fires a /draft patch (one IPC per character).
  const frontendPatchTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (frontendPatchTimerRef.current !== null) {
      window.clearTimeout(frontendPatchTimerRef.current);
    }
    frontendPatchTimerRef.current = window.setTimeout(() => {
      frontendPatchTimerRef.current = null;
      // Snapshot the watched slices. Each entry maps a JSON-Pointer-like
      // path the bridge will store under to a value the frontend computes
      // from current state.
      const sidebar =
        (state.sidebar as Record<string, unknown> | undefined) ?? {};
      const tabs = (state.tabs as Tab[] | undefined) ?? [];
      const messagesCount =
        ((state.messages as unknown[] | undefined) ?? []).length;
      const slices: Record<string, unknown> = {
        "/sidebar/models": sidebar.models ?? [],
        "/sidebar/themes": sidebar.themes ?? [],
        "/connection": state.connection ?? "disconnected",
        "/status": state.status ?? "",
        "/draft": state.draft ?? "",
        "/messagesCount": messagesCount,
        "/tabs": tabs.map((t) => ({
          id: t.id,
          label: t.label,
          model: t.model ?? "",
          active: t.id === (state.activeTabId as string | undefined),
        })),
      };
      const last = lastFrontendStateRef.current;
      const next: Record<string, string> = { ...last };
      let changed = false;
      for (const [path, value] of Object.entries(slices)) {
        const serialized = JSON.stringify(value);
        if (last[path] === serialized) continue;
        next[path] = serialized;
        changed = true;
        // Fire-and-forget — bridge processes the patch and updates its
        // frontendState map. No ack needed; this is one-way mirroring.
        invoke("agent_command", {
          payload: JSON.stringify({
            type: "frontend_state_patch",
            path,
            value,
          }),
        }).catch(() => {
          // Bridge gone or webview reloaded mid-flight — fine, the next
          // patch will retry, and the bridge sees these as best-effort.
        });
      }
      if (changed) lastFrontendStateRef.current = next;
    }, 16);
    return () => {
      if (frontendPatchTimerRef.current !== null) {
        window.clearTimeout(frontendPatchTimerRef.current);
        frontendPatchTimerRef.current = null;
      }
    };
  }, [state]);

  useEffect(() => {
    // The boot sequence (start_agent → boot_layout → report) and the
    // `agent-response` listener live in `useBridgeMessages` — see the
    // call site near the bottom of this component. The remaining
    // listeners below own OS-edge events (PTY streams, agent supervisor
    // signals, native menu, drag-drop, paste) that aren't bridge
    // messages, so they stay in this effect.

    // M6 P1: shell-output streams a PTY chunk. Append to the originating
    // shell-tab's terminalBuffer and dispatch a per-tab window event so
    // the shell-canvas composite (subscribed by tabId) writes the chunk
    // to its xterm. Inactive shell-tab output stays buffered until the
    // user switches to it (replay-on-mount, same pattern as agent
    // bash output for the read-only Terminal panel).
    const unlistenShellOutput = listen<{ tabId: string; content: string }>(
      "shell-output",
      (event) => {
        const { tabId, content } = event.payload;
        if (!tabId || typeof content !== "string") return;
        updateTab(tabId, (t) => {
          const next = t.terminalBuffer + content;
          const trimmed = next.length > TERMINAL_REPLAY_MAX
            ? next.slice(next.length - TERMINAL_REPLAY_MAX)
            : next;
          return { ...t, terminalBuffer: trimmed };
        });
        window.dispatchEvent(
          new CustomEvent(`aethon:shell-output:${tabId}`, { detail: content }),
        );
      },
    );

    // M6 P1: shell-exit fires once when the PTY child process ends.
    // Flip the tab's shell.shellState to "exited" so the canvas can
    // show a closed-process indicator; the slot is left in the Rust
    // registry until tab close (cleanup is idempotent).
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

    // M6 follow-up: shell-title fires whenever a PTY's stdout contains
    // an OSC 0/1/2 title-set sequence. Replace the tab label with the
    // shell-emitted title so the user sees `vim · README.md` /
    // `user@host` / `htop` instead of the static `Shell N`. Falls
    // back to the default label if the user never opens a tool that
    // reports titles — that's the existing behaviour.
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

    const unlistenReload = listen<string>("agent-reloaded", () => {
      activeResponseIdRef.current = null;
      for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
      hangWarnTimersRef.current.clear();
      for (const tid of hangWarnActiveRef.current) dismissNotification(hangWarnNotifId(tid));
      hangWarnActiveRef.current.clear();
      setStatusFlags({ waiting: false, status: "agent reloaded" });
      // Re-prime the agent so we get a fresh `ready` event with the new code.
      invoke("start_agent").catch(() => {
        /* surfaced by the next user action */
      });
    });

    // P5: bridge crash recovery. Rust supervisor emits this when the
    // bun child exits unexpectedly (intentional hot-reload kills go
    // through `agent-reloaded` instead). Clear all per-tab waiting
    // state, surface a notice, and auto-restart per [shell] config.
    const unlistenCrashed = listen<{ pid?: number; stderrTail?: string[] }>(
      "agent-crashed",
      (event) => {
        const tail = event.payload?.stderrTail ?? [];
        const lastLine = tail.length > 0 ? tail[tail.length - 1] : "no stderr";
        activeResponseIdRef.current = null;
        for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
        hangWarnTimersRef.current.clear();
        for (const tid of hangWarnActiveRef.current) dismissNotification(hangWarnNotifId(tid));
        hangWarnActiveRef.current.clear();
        // Clear waiting/queue across every tab — pi sessions are gone.
        setState((prev) => {
          const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) => ({
            ...t,
            waiting: false,
            queueCount: 0,
          }));
          return {
            ...prev,
            tabs,
            waiting: false,
            queueCount: 0,
            status: "agent crashed",
          };
        });
        const willAutoRestart = autoRestartAgentRef.current;
        pushNotification({
          id: "ae-agent-crashed",
          title: "Agent process exited unexpectedly",
          message: lastLine.slice(0, 200),
          kind: "error",
          // Keep visible until the user dismisses or restart succeeds —
          // a transient toast would race a user who's away from the
          // keyboard while a long agent turn died.
          durationMs: null,
          actions: willAutoRestart
            ? [{ label: "Dismiss", action: "ae-agent-crashed:dismiss" }]
            : [
                { label: "Restart", action: "ae-agent-crashed:restart" },
                { label: "Dismiss", action: "ae-agent-crashed:dismiss" },
              ],
        });
        if (willAutoRestart) {
          // Brief delay so the user actually sees the notice flash
          // before the next request silently respawns. The next chat
          // send will respawn anyway via ensure_agent_spawned, but
          // priming here means the system-prompt + ready handshake
          // happens up-front.
          window.setTimeout(() => {
            invoke("start_agent").catch(() => {
              /* respawn deferred to next user action */
            });
          }, 500);
        }
      },
    );

    // Mirror agent stderr into the chat as a system message — when the bridge
    // dies on startup this is the only signal we have.
    const unlistenStderr = listen<string>("agent-stderr", (event) => {
      const text = event.payload?.toString().trim();
      if (!text) return;
      // Surface only real failures. Two tiers:
      //   1. Bridge log lines tagged WARN / ERROR / FATAL (the bun
      //      logger writes `<ISO> LEVEL scope: msg`). We deliberately
      //      ignore INFO/DEBUG so noisy progress lines like
      //      `… load took 0ms (loaded=0 failed=0)` don't pop into chat
      //      just because they contain the substring "fail".
      //   2. Raw uncaught throws / panics / module-resolution errors
      //      that escape the logger entirely (matched by anchor or
      //      well-known prefixes, not loose substrings).
      const isLeveledFailure = /\b(WARN|ERROR|FATAL)\b/.test(text);
      const isRawCrash =
        /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|panic:)/i.test(text) ||
        /\bthrow\s+new\s|\bCannot\s+find\s+(module|package)\b|\bEACCES\b|\bENOENT\b/i.test(text);
      // Routine extension feedback (size-guard rejections, etc.) goes to bridge
      // logs only — surfacing it to chat would spam the feed when an extension
      // misbehaves on a setInterval.
      const isExtensionNoise = /\b(WARN|INFO)\s+ext-state:/.test(text);
      if ((isLeveledFailure || isRawCrash) && !isExtensionNoise) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "system",
          text: `[agent stderr] ${text}`,
        });
      }
      // Always log to webview console for debug skill access.
      console.warn("[agent stderr]", text);
    });

    // Native menu activations land here. The Rust shell emits the
    // menu item id; we route the same way the keyboard shortcuts do
    // so menu and Cmd+T / Cmd+] / etc. always do the same thing.
    const unlistenMenu = listen<string>("menu", (event) => {
      const id = event.payload;
      // Extension menu items use the `ext:<action>` prefix so they don't
      // collide with built-in ids. Route them through the existing
      // a2ui_event channel as {componentType:"menu-item",
      // componentId:"menu-item__tpl__<action>", data:{action}} so a
      // paired aethon.onEvent({componentType:"menu-item",
      // descendantId:"<action>"}, handler) fires.
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
      switch (id) {
        // M6 restructure: "File → New Tab" (Cmd+T) opens an agent tab
        // — the menu can't observe webview focus, so it picks the
        // safer default. The webview keydown handler intercepts Cmd+T
        // when focus is in the bottom terminal panel and routes to
        // newShellTab there. "File → New Shell Tab" (Cmd+Shift+T) is
        // the explicit shell-tab path. The legacy "new_agent_tab" id
        // is kept as an alias in case any older payload references it.
        case "new_tab":
        case "new_agent_tab":
          newTab();
          break;
        case "new_shell_tab":
          newShellTab();
          break;
        case "close_tab": {
          const activeId = stateRef.current.activeTabId as string | undefined;
          if (activeId) closeTab(activeId);
          break;
        }
        case "next_tab": nextTab(1); break;
        case "prev_tab": nextTab(-1); break;
        case "toggle_terminal": toggleTerminal(); break;
        case "clear_chat": clearChat(); break;
        case "stop_prompt": void stopPrompt(); break;
        case "check_updates": {
          checkForUpdates().catch((err) => {
            appendSystem(`Update check failed: ${err}`);
          });
          break;
        }
        case "help_docs": {
          openUrl("https://github.com/utensils/aethon").catch(() => {
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

    // P4: drag-and-drop file paths from the OS. Tauri 2's webview
    // exposes the paths directly (HTML5 dataTransfer is sandboxed and
    // only yields File handles). Routing:
    //   * Drop on the bottom terminal panel while a shell sub-tab is
    //     active, or anywhere when the active top-level tab is a shell
    //     → write shell-quoted POSIX path(s) into the PTY via
    //     `shell_input`. Each path is single-quote-wrapped via the
    //     shellQuote helper so spaces / metacharacters never break the
    //     paste into multiple tokens.
    //   * Otherwise (active tab is an agent tab) → append
    //     `@<absolute-path>` tokens to the draft.
    // Position hit-test uses `document.elementFromPoint` against the
    // physical-to-CSS-pixel-converted drop coordinates so the user can
    // drop directly onto the panel they want to receive the path.
    const dragDropDisposer = (async () => {
      try {
        const { getCurrentWebview } = await import(
          "@tauri-apps/api/webview"
        );
        return await getCurrentWebview().onDragDropEvent((evt) => {
          if (evt.payload.type !== "drop") return;
          const paths = evt.payload.paths ?? [];
          if (paths.length === 0) return;
          const activeId = stateRef.current.activeTabId as
            | string
            | undefined;
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
              const tp = (stateRef.current.terminalPanel as
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

    // Image paste into the chat composer. Tauri webview surfaces clipboard
    // images via `event.clipboardData.items`; for each `image/*` item we
    // persist the bytes to `~/.aethon/pastes/<uuid>.<ext>` via the
    // `save_paste_image` Tauri command and insert `@<path>` into the
    // active agent tab's draft. The agent's existing read tool can then
    // pick up the image via the path. Files larger than the Rust 32 MiB
    // cap surface as a notification rather than silently dropping.
    const onClipboardPaste = (e: ClipboardEvent) => {
      const focused = document.activeElement;
      const composer = document.querySelector(".a2ui-chat-input");
      if (!composer || !focused || !composer.contains(focused)) return;
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageItems: DataTransferItem[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          imageItems.push(it);
        }
      }
      if (imageItems.length === 0) return;
      e.preventDefault();
      // Capture the target tab at paste time, NOT after the async save
      // resolves — otherwise pasting a slow-saving image in tab A and
      // switching to tab B before save_paste_image returns would
      // attach the @path token to whichever agent tab is active later.
      const targetId = stateRef.current.activeTabId as string | undefined;
      if (!targetId) return;
      const targetTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      const targetTab = targetTabs.find((t) => t.id === targetId);
      if (!targetTab || targetTab.kind !== "agent") return;
      void Promise.all(
        imageItems.map(async (item) => {
          const file = item.getAsFile();
          if (!file) return null;
          const buffer = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const ext = file.type.split("/")[1] ?? "png";
          try {
            const path = await invoke<string>("save_paste_image", {
              bytes,
              extension: ext,
            });
            return path;
          } catch (err) {
            pushNotification({
              id: "ae-paste-image-failed",
              title: "Image paste failed",
              message: err instanceof Error ? err.message : String(err),
              kind: "error",
              durationMs: 3000,
            });
            return null;
          }
        }),
      ).then((paths) => {
        const tokens = paths
          .filter((p): p is string => typeof p === "string")
          .map((p) => `@${p}`)
          .join(" ");
        if (tokens.length === 0) return;
        // Verify the captured tab still exists (the user could have
        // closed it during the async save). If it's gone, the @path
        // tokens are orphaned — better than appending to an unrelated
        // tab. The pasted file remains in ~/.aethon/pastes/ for manual
        // recovery.
        const stillExists = (stateRef.current.tabs as Tab[] | undefined)
          ?.some((t) => t.id === targetId);
        if (!stillExists) return;
        updateTab(targetId, (t) => ({
          ...t,
          draft: t.draft.length > 0 ? `${t.draft} ${tokens}` : tokens,
        }));
      });
    };
    document.addEventListener("paste", onClipboardPaste, true);

    return () => {
      unlistenReload.then((fn) => fn());
      unlistenCrashed.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
      unlistenMenu.then((fn) => fn());
      unlistenShellOutput.then((fn) => fn());
      unlistenShellExit.then((fn) => fn());
      unlistenShellTitle.then((fn) => fn());
      dragDropDisposer.then((fn) => fn?.());
      document.removeEventListener("paste", onClipboardPaste, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Append a chat message, or replace in place if a message with the same
  // id already exists. This is what lets the bridge stream "running…" tool
  // cards and update them with the final result without duplicating bubbles.
  // tabId routes to the right tab record; defaults to the active tab so
  // legacy callers that pre-date the multi-tab refactor stay correct.
  function appendMessage(msg: ChatMessage, tabId?: string) {
    const id = tabId ?? (stateRef.current.activeTabId as string | undefined) ?? "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        messages[idx] = msg;
      } else {
        messages.push(msg);
      }
      return { ...tab, messages };
    });
  }

  // Append a streaming text delta to its bubble. When the bridge supplies a
  // stable `messageId` (one per pi assistant message), look up the bubble by
  // id anywhere in the array — this keeps text from a single agent message in
  // one bubble even after tool cards land between deltas. Without a messageId
  // (legacy bridges), fall back to the previous "is it the last message?"
  // behavior tracked via activeResponseIdRef.
  function appendOrAmendAgentText(delta: string, messageId?: string, tabId?: string) {
    const id = tabId ?? (stateRef.current.activeTabId as string | undefined) ?? "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      if (messageId) {
        const idx = messages.findIndex((m) => m.id === messageId);
        if (idx >= 0) {
          messages[idx] = {
            ...messages[idx],
            text: (messages[idx].text ?? "") + delta,
          };
        } else {
          messages.push({ id: messageId, role: "agent", text: delta });
        }
        activeResponseIdRef.current = messageId;
        return { ...tab, messages };
      }
      const activeId = activeResponseIdRef.current;
      const last = messages[messages.length - 1];
      if (activeId && last && last.id === activeId && last.role === "agent") {
        messages[messages.length - 1] = {
          ...last,
          text: (last.text ?? "") + delta,
        };
      } else {
        const newId = crypto.randomUUID();
        activeResponseIdRef.current = newId;
        messages.push({ id: newId, role: "agent", text: delta });
      }
      return { ...tab, messages };
    });
  }

  function setStatusFlags(
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) {
    setState((prev) => ({ ...prev, ...flags }));
  }


  // Tab buckets keyed by project (or NO_PROJECT_KEY). When the user
  // switches active project, we snapshot the current state.tabs +
  // activeTabId into the OLD bucket and load the NEW bucket into state
  // — that's how tabs become per-project visible without us having to
  // filter on every render. New tabs get the active projectId baked in
  // (see newTab) so the bucket they end up in matches their tag.
  const tabBucketsRef = useRef<
    Map<string, { tabs: Tab[]; activeTabId: string | undefined }>
  >(new Map());

  // Project I/O (git status polling, bridge IPC for cwd + extension
  // watching). The hook owns the gitStatusRef cache, the 30s poll
  // effect, and announce/watch/unwatch invokes; orchestrators
  // (openProjectByPath et al.) stay inline because they mutate
  // tabBucketsRef and trigger terminal replay — they'll move when
  // useTabs is extracted.
  const {
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
  } = useProjects({
    getProjectPaths: () => projectsRef.current.projects.map((p) => p.path),
    onGitStatusChanged: () => syncProjectsToState(),
  });

  // Mirror the projects state into app state so layouts can $ref it.
  // Bumps `/projects`, `/activeProjectId`, `/project/{label,path,id}`,
  // `/sessionLabel` and `/sidebar/projects` (sidebar item array).
  // Called on every mutation
  // so a single helper keeps the shape consistent. Carries the cached
  // git status from gitStatusRef so a sync triggered for non-git
  // reasons (lastUsed bump, label change) doesn't drop the badges.
  function syncProjectsToState() {
    const ps = projectsRef.current;
    const active = activeProject(ps);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const tabIds = new Set(
        (((prev.tabs as Tab[] | undefined) ?? []).map((t) => t.id)).concat(["default"]),
      );
      return {
        ...prev,
        projects: ps.projects,
        activeProjectId: ps.activeId,
        project: active
          ? { id: active.id, label: active.label, path: active.path }
          : null,
        sessionLabel: active ? active.label : "",
        sidebar: {
          ...sidebar,
          projects: ps.projects.map((p) => ({
            id: p.id,
            // Basename is what we surface; the absolute path lives
            // behind the row's native tooltip (title attribute) so
            // the row label stays compact even with deep paths.
            label: p.label,
            tooltip: p.path,
            active: p.id === ps.activeId,
            git: gitStatusRef.current.get(p.path),
          })),
        },
        recentSessions: recentSessionItems(
          scopedDiscoveredSessions(allDiscoveredSessionsRef.current),
          tabIds,
        ),
      };
    });
  }

  // Persist + mirror. Errors are logged; the in-memory ref still wins so
  // a transient disk failure doesn't leave the UI inconsistent with what
  // the user just did.
  async function persistProjects() {
    try {
      await saveProjects(projectsRef.current);
    } catch (err) {
      console.warn("saveProjects failed:", err);
    }
    syncProjectsToState();
  }

  // Bridge IPC: spawns the agent on mount, runs the boot handshake
  // (start_agent → boot_layout → report), and routes every
  // `agent-response` event through the per-type handler registry under
  // src/hooks/bridgeMessageHandlers/. Returns `ackMutation` for callers
  // (none today, but kept on the public API) that need to settle a
  // bridge promise outside the response path.
  useBridgeMessages({
    bootLayout: BOOT_LAYOUT,
    onBootError: (err) => {
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to start agent: ${err}`,
      });
      setStatusFlags({ status: "error" });
    },
    ctx: {
      setState,
      setLayout,
      stateRef,
      registry,
      piDefaultModelRef,
      allDiscoveredSessionsRef,
      projectsRef,
      projectsLoadedRef,
      activeResponseIdRef,
      hangWarnTimersRef,
      hangWarnActiveRef,
      turnStartedAtRef,
      lastExtensionStateKeysRef,
      pendingTabOpens,
      updateTab,
      updateActiveTab,
      dispatchTerminalReplay,
      autoRestoreDiscoveredSessions,
      hydrateThemes,
      hydrateExtensions,
      hydrateSlashCommands,
      hydrateKeybindings,
      hydrateEventRoutes,
      hydrateExtensionLayouts,
      hydrateFrontendModules,
      announceProjectToBridge,
      appendMessage,
      appendOrAmendAgentText,
      setStatusFlags,
      pushNotification,
      dismissNotification,
      maybeFireCompletionNotification,
      knownTabIds,
      scopedDiscoveredSessions,
      recentSessionItems,
      syncRecentSessionsToState,
      recomputeModelPicker,
      routeShellWrite,
    },
  });

  // Load projects once at boot. Done in its own effect so a slow disk
  // doesn't push out the agent-start path. Mirrors into state on resolve
  // so the sidebar populates without a re-render trigger.
  useEffect(() => {
    (async () => {
      const ps = await loadProjects();
      projectsRef.current = ps;
      projectsLoadedRef.current = true;
      syncProjectsToState();
      // Kick a git status fetch for every loaded project so badges
      // appear on the first paint instead of waiting for the 30s tick.
      void refreshAllGitStatus();
      // Tell the bridge about the active project so the default tab's
      // session opens with the right cwd. ensureTab() in the bridge
      // checks the per-tab cwd record before SessionManager.continueRecent.
      const active = activeProject(ps);
      const tabId =
        (stateRef.current.activeTabId as string | undefined) ?? "default";
      if (active) {
        announceProjectToBridge(tabId, active.path);
        // Hot-reload the active project's `.aethon/extensions/` from
        // boot, not just from the next setActiveProjectById call.
        watchProjectForBridge(active.path);
        // Retag any pre-load tabs (default boot tab + bridge replays) so
        // they live in the active project's bucket from now on. Without
        // this they'd stay in NO_PROJECT_KEY and silently disappear the
        // first time the user switches projects.
        setState((prev) => {
          const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) =>
            t.projectId == null ? { ...t, projectId: active.id } : t,
          );
          return { ...prev, tabs };
        });
      }
      const scoped = scopedDiscoveredSessions(allDiscoveredSessionsRef.current);
      autoRestoreDiscoveredSessions(scoped, knownTabIds());
      syncRecentSessionsToState();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openProjectFromPicker(): Promise<string | null> {
    const path = await pickProjectDirectory();
    if (!path) return null;
    return openProjectByPath(path);
  }

  function openProjectByPath(path: string, label?: string): string {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const { state: nextProjects, id } = upsertProject(
      projectsRef.current,
      path,
      label,
    );
    projectsRef.current = nextProjects;
    persistProjects();
    // Fetch git status for the (possibly new) project so the chip
    // appears on the same render that adds the row, not 30s later.
    void refreshGitStatusFor(path);
    // Switch to the project's tab bucket BEFORE notifying the bridge.
    // If this is a brand-new project, the bucket is empty — the empty
    // state composite will render so the caller can decide whether to
    // auto-create a fresh tab.
    switchProjectBucket(fromKey, projectBucketKey(id));
    syncRecentSessionsToState();
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    announceProjectToBridge(tabId, path);
    return id;
  }

  // Snapshot current state.tabs + activeTabId into the OLD project's
  // bucket, then load the NEW project's bucket back into state. The
  // active tab's view (messages / draft / canvas / model) is mirrored
  // to the root keys so the layout sees the new project's view
  // immediately. If the new project has no bucket yet, we leave tabs
  // empty + flip /empty so the empty-state composite renders — the
  // caller (newTab/openProjectByPath) decides whether to seed a tab.
  function switchProjectBucket(
    fromKey: string,
    toKey: string,
  ) {
    if (fromKey === toKey) return;
    let nextTerminalBuffer = "";
    setState((prev) => {
      // Save current bucket.
      const currentTabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const currentActive = prev.activeTabId as string | undefined;
      tabBucketsRef.current.set(fromKey, {
        tabs: currentTabs,
        activeTabId: currentActive,
      });
      // Load target bucket (or empty).
      const next = tabBucketsRef.current.get(toKey) ?? {
        tabs: [],
        activeTabId: undefined,
      };
      // Heal an orphaned bucket: tabs present but the saved activeTabId
      // doesn't match any of them (or is missing). Without this fixup,
      // the fallthrough below would set empty:true with tabs.length>0,
      // leaving the canvas and empty-state both visibly inconsistent.
      const hasOrphan =
        next.tabs.length > 0 &&
        !next.tabs.some((t) => t.id === next.activeTabId);
      const activeTabId = hasOrphan ? next.tabs[0].id : next.activeTabId;
      const result: Record<string, unknown> = {
        ...prev,
        tabs: next.tabs,
        activeTabId,
      };
      const activeTab = next.tabs.find((t) => t.id === activeTabId);
      if (activeTab) {
        const rec = activeTab as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = rec[key as string];
        }
        result.empty = false;
        result.hasTabs = true;
        result.sidebar = recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          activeTab.model,
        );
        nextTerminalBuffer = activeTab.terminalBuffer ?? "";
      } else {
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = undefined;
        }
        result.empty = true;
        result.hasTabs = next.tabs.length > 0;
        nextTerminalBuffer = "";
      }
      return result;
    });
    // Replay the new active tab's terminal buffer (or clear if none).
    dispatchTerminalReplay(nextTerminalBuffer);
  }

  function setActiveProjectById(id: string): boolean {
    const ps = projectsRef.current;
    const target = ps.projects.find((p) => p.id === id);
    if (!target) return false;
    const fromKey = projectBucketKey(ps.activeId);
    const toKey = projectBucketKey(id);
    const previousActive = activeProject(ps);
    projectsRef.current = {
      projects: ps.projects.map((p) =>
        p.id === id ? { ...p, lastUsed: Date.now() } : p,
      ),
      activeId: id,
    };
    persistProjects();
    switchProjectBucket(fromKey, toKey);
    syncRecentSessionsToState();
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    announceProjectToBridge(tabId, target.path);
    // Swap the file-watcher's project ext dir so edits in the new
    // project's `.aethon/extensions/` hot-reload, and edits in the old
    // one stop firing.
    if (previousActive && previousActive.path !== target.path) {
      unwatchProjectForBridge(previousActive.path);
    }
    watchProjectForBridge(target.path);
    return true;
  }

  function clearActiveProject() {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const previousActive = activeProject(projectsRef.current);
    projectsRef.current = { ...projectsRef.current, activeId: null };
    persistProjects();
    switchProjectBucket(fromKey, NO_PROJECT_KEY);
    syncRecentSessionsToState();
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    announceProjectToBridge(tabId, null);
    if (previousActive) unwatchProjectForBridge(previousActive.path);
  }

  function removeProjectById(id: string): boolean {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const wasActive = projectsRef.current.activeId === id;
    const removedKey = projectBucketKey(id);
    const result = removeProject(projectsRef.current, id);
    if (!result.removed) return false;

    const removedPath = result.removed.path;
    projectsRef.current = result.state;
    gitStatusRef.current.delete(removedPath);
    persistProjects();

    if (wasActive) {
      switchProjectBucket(fromKey, NO_PROJECT_KEY);
      syncRecentSessionsToState();
      const tabId =
        (stateRef.current.activeTabId as string | undefined) ?? "default";
      announceProjectToBridge(tabId, null);
      tabBucketsRef.current.delete(removedKey);
    } else {
      tabBucketsRef.current.delete(removedKey);
      syncRecentSessionsToState();
    }
    // Always unwatch — the project may have been active or just on the
    // recents list with its ext dir watched eagerly. Idempotent on the
    // Rust side, so calling for a never-watched path is harmless.
    unwatchProjectForBridge(removedPath);

    return true;
  }

  // Walk the layout tree and produce a deduped, sorted list of component
  // types found in it. Lets a layout/extension inspect the active payload
  // via `/sidebar/components` instead of needing a hardcoded list. Keeps
  // the entry shape sidebar items expect ({id, label, active}). Active is
  // set true for every type since the layout DOES contain it; clicking
  // does nothing today.


  // Layout activation helper — single path used by both
  // window.aethon.activateLayout and the /layout slash command. Seeds
  // the layout's state defaults for keys absent from current app state
  // (live state wins on collisions) and rebuilds /sidebar/layouts from
  // the catalogue + current active id so layout JSONs don't have to
  // ship a hardcoded `active: true` flag.










  function appendSystem(text: string) {
    appendMessage({ id: crypto.randomUUID(), role: "system", text });
  }

  // ---------------------------------------------------------------------
  // Notifications — toast stack rendered at App root. Used for mutation
  // feedback (theme set, layout switched) and agent-pushed `notice`s.
  // Stays out of chat history so the conversation surface isn't cluttered
  // with UI bookkeeping.
  // ---------------------------------------------------------------------
  function pushNotification(input: {
    id?: string;
    title: string;
    message?: string;
    kind?: NotificationKind;
    durationMs?: number | null;
    actions?: { label: string; action: string }[];
  }): string {
    const id = input.id ?? crypto.randomUUID();
    const entry: NotificationEntry = {
      id,
      title: input.title,
      ...(input.message ? { message: input.message } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      // Default to a 4 s auto-dismiss for transient feedback. Pass
      // `null` to make a notification sticky (warnings with actions
      // typically want this).
      durationMs:
        input.durationMs === null
          ? null
          : (input.durationMs ?? 4000),
      ...(input.actions && input.actions.length > 0
        ? { actions: input.actions }
        : {}),
      createdAt: Date.now(),
    };
    setState((prev) => {
      const list = (prev.notifications as NotificationEntry[] | undefined) ?? [];
      // Dedup by id — if a notification with the same id is already
      // visible, replace it. Lets repeated triggers (rapid ⌘+/-,
      // burst mutation feedback) refresh the toast in place rather
      // than stack 5 copies.
      const without = list.filter((n) => n.id !== entry.id);
      // Cap the visible stack so a runaway extension can't spam toasts
      // off-screen. Newest wins; the oldest beyond the cap is dropped.
      const MAX_VISIBLE = 6;
      const next = [...without, entry];
      const trimmed = next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      // Drop side effect: any pending consent prompts that just got
      // silently evicted (dedup or trim) need their resolver fired so
      // the originator promise doesn't dangle. Both shell-write
      // (5-min bridge timeout) and shell-close (Cmd+W → tab stays
      // alive) need this guarantee.
      const survivedIds = new Set(trimmed.map((n) => n.id));
      for (const n of list) {
        if (!survivedIds.has(n.id)) {
          resolveShellWriteConsent(n.id, false);
          resolveShellCloseConsent(n.id, false);
        }
      }
      return { ...prev, notifications: trimmed };
    });
    return id;
  }
  function dismissNotification(id: string) {
    setState((prev) => {
      const list = (prev.notifications as NotificationEntry[] | undefined) ?? [];
      return { ...prev, notifications: list.filter((n) => n.id !== id) };
    });
  }

  /** P4: native OS notification on agent turn completion. Fires when:
   *    1. `[ui] notify_on_completion` is true (default), AND
   *    2. The turn ran at least `notify_min_duration_seconds` seconds, AND
   *    3. The window is unfocused OR the originating tab isn't the
   *       active one (i.e. the user is not looking at the result).
   *
   *  Click → focus the window + switch to that tab. Permission is
   *  requested lazily on first call so the OS prompt only appears
   *  when there's actually something to notify about (Tauri's
   *  notification plugin handles the macOS / Linux / Windows backend).
   */
  async function maybeFireCompletionNotification(input: {
    tabId: string;
    turnDurationMs: number;
  }) {
    if (!notifyOnCompletionRef.current) return;
    if (input.turnDurationMs < notifyMinDurationMsRef.current) return;
    // Only fire when the user can't already see the result. Active-tab
    // check: a focused window with the originating tab active means the
    // user is looking at it; no notification needed.
    const windowFocused = typeof document !== "undefined" && document.hasFocus();
    const isActiveTab =
      stateRef.current.activeTabId === input.tabId;
    if (windowFocused && isActiveTab) return;
    try {
      const notif = await import("@tauri-apps/plugin-notification");
      let granted = await notif.isPermissionGranted();
      if (!granted) {
        const perm = await notif.requestPermission();
        granted = perm === "granted";
      }
      if (!granted) return;
      const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      const tab = tabs.find((t) => t.id === input.tabId);
      const lastMsg = tab?.messages?.at(-1);
      const body =
        typeof lastMsg?.text === "string" && lastMsg.text.length > 0
          ? lastMsg.text.slice(0, 120)
          : "Turn complete.";
      notif.sendNotification({
        title: tab?.label ? `${tab.label} ✓` : "Aethon ✓",
        body,
      });
    } catch (err) {
      console.warn("notification fire failed:", err);
    }
  }

  // ---------------------------------------------------------------------
  // Command palette helpers — open/close/run. The palette renders at App
  // root over every layout. Items are derived in the component itself
  // (selectPaletteItems) from existing state slices, so opening with a
  // mode is enough — no items list to populate here.
  // ---------------------------------------------------------------------
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
        if (fresh.ui.theme) {
          document.documentElement.dataset.theme = fresh.ui.theme;
        }
        const size = fresh.ui.fontSize;
        if (typeof size === "number" && Number.isFinite(size)) {
          const clamped = Math.max(10, Math.min(24, Math.round(size)));
          document.documentElement.style.setProperty(
            "--app-font-size",
            `${clamped}px`,
          );
        }
        defaultShareModeRef.current = fresh.shell.defaultShareMode;
        notifyOnCompletionRef.current = fresh.ui.notifyOnCompletion;
        notifyMinDurationMsRef.current =
          Math.max(0, fresh.ui.notifyMinDurationSeconds) * 1000;
        autoRestartAgentRef.current = fresh.shell.autoRestartAgent;
        shellDefaultCommandRef.current = fresh.shell.defaultCommand;
        shellDefaultArgsRef.current = fresh.shell.defaultArgs;
        shellInheritEnvRef.current = fresh.shell.inheritEnv;
        shellPromptBeforeCloseRef.current = fresh.shell.promptBeforeClose;
        shortcutsNewTabKindRef.current = fresh.shortcuts.newTabKind;
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

  function openPalette(mode: PaletteMode) {
    setState((prev) => ({
      ...prev,
      palette: { ...(prev.palette ?? {}), open: true, mode, query: "", selectedIndex: 0 },
    }));
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
        } else if (p.action === "builtin:meta+]") nextTab(1);
        else if (p.action === "builtin:meta+[") nextTab(-1);
        else if (p.action === "builtin:meta+`") toggleTerminalAndFocus();
        else if (p.action === "builtin:meta+0") toggleFocusComposerTerminal();
        else if (p.action === "builtin:meta+k") clearChat();
        else if (p.action === "builtin:meta+.") void stopPrompt();
        else if (p.action === "builtin:meta+p") openPalette("switcher");
        else if (p.action === "builtin:meta+shift+p") openPalette("commands");
        else if (p.action === "builtin:meta+=") adjustZoom(0.1);
        else if (p.action === "builtin:meta+-") adjustZoom(-0.1);
        else if (p.action === "builtin:meta+shift+0") resetZoom();
        return;
    }
  }

  // Manual "Check for Updates" — wired from the Aethon menu and the
  // tray menu. Walks tauri-plugin-updater's check → download → install
  // pipeline and relaunches when done. Posts non-terminal status as
  // system messages so the user sees what's happening; failures bubble
  // up to the menu handler's catch and become a system error bubble.
  //
  // The Rust shell only registers the updater plugin when a pubkey is
  // configured; if not, `updater_available` returns false and we tell
  // the user clearly instead of throwing on the first invoke.
  async function checkForUpdates() {
    let available = false;
    try {
      available = await invoke<boolean>("updater_available");
    } catch {
      /* assume unavailable */
    }
    if (!available) {
      appendSystem(
        "Updater isn't configured for this build. See RELEASING.md to set up signing keys.",
      );
      return;
    }
    appendSystem("Checking for updates…");
    let update: Awaited<ReturnType<typeof checkUpdate>>;
    try {
      update = await checkUpdate();
    } catch (err) {
      appendSystem(`Update check failed: ${err}`);
      return;
    }
    if (!update) {
      appendSystem("Aethon is up to date.");
      return;
    }
    appendSystem(`Update available: ${update.version}. Downloading…`);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            // Periodic-ish progress: every 10% so the chat doesn't drown.
            if (pct % 10 === 0) appendSystem(`Update download: ${pct}%`);
          }
        } else if (event.event === "Finished") {
          appendSystem("Update downloaded. Restarting…");
        }
      });
      await relaunch();
    } catch (err) {
      appendSystem(`Update install failed: ${err}`);
    }
  }

  // Build the dispatch context fresh per invocation so handlers see latest
  // state (model list, skills) without re-creating the command registry.
  function slashContext(): SlashCommandContext {
    return {
      appendSystem,
      notify: (input) => {
        pushNotification(input);
      },
      clearChat,
      setTheme,
      listThemes,
      setModel,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      listExtensions: () => registry.list().map((s) => s.name),
      installExtension: async (spec: string) => {
        return await invoke<string>("install_aethon_extension", { spec });
      },
      listModels: () => {
        const sidebar = (stateRef.current.sidebar as Record<string, unknown>) ?? {};
        return ((sidebar.models as { id: string; label: string; active?: boolean }[]) ?? []);
      },
      toggleTerminal,
      toggleSidebar,
      activateLayout: activateLayoutById,
      listLayouts: () =>
        layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
        })),
      pickProject: openProjectFromPicker,
      openProject: (path: string, label?: string) => openProjectByPath(path, label),
      setActiveProject: setActiveProjectById,
      clearProject: clearActiveProject,
      removeProject: removeProjectById,
      listProjects: () =>
        projectsRef.current.projects.map((p) => ({
          id: p.id,
          label: p.label,
          path: p.path,
        })),
      activeProject: () => {
        const a = activeProject(projectsRef.current);
        return a ? { id: a.id, label: a.label, path: a.path } : null;
      },
    };
  }

  async function sendChat(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Client-side slash commands handle UI-only actions (clear, theme, etc.).
    // Unknown slash commands fall through to the agent so pi's own slash
    // command handling and any prompt-template / skill commands still reach
    // it. `//foo` escapes to force a literal `/foo` to be sent.
    const parsed = parseSlashCommand(trimmed);
    if (parsed) {
      const cmd = slashCommandsRef.current.find((c) => c.name === parsed.name);
      if (cmd) {
        const slashTabId =
          (stateRef.current.activeTabId as string | undefined) ?? "default";
        appendMessage(
          { id: crypto.randomUUID(), role: "user", text: trimmed },
          slashTabId,
        );
        // Clear via updateActiveTab — without this, the active tab's
        // draft still holds the slash text and any subsequent mirror
        // (clearChat, theme switch, …) writes it back into root.draft,
        // making the input "stick".
        updateActiveTab((tab) => ({ ...tab, draft: "" }));
        try {
          await cmd.run(parsed.args, slashContext());
        } catch (err) {
          appendSystem(`Slash command \`/${parsed.name}\` failed: ${err}`);
        }
        return;
      }
      // Unknown — fall through to send_message. Pi's own command handling on
      // the agent side may pick it up; if not, the LLM sees the literal text.
    }

    const sendText = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    const tabId = (stateRef.current.activeTabId as string | undefined) ?? "default";
    appendMessage(
      { id: crypto.randomUUID(), role: "user", text: sendText },
      tabId,
    );
    updateTab(tabId, (tab) => ({ ...tab, draft: "", waiting: true }));
    setState((prev) => ({
      ...prev,
      status: "thinking…",
      connection: "connected",
    }));

    // Wait for any pending tab_open on this tab to land first so the
    // bridge has the right initial model before the chat creates the
    // session lazily. swallow any open errors — sendChat surfaces its
    // own error path below.
    const pending = pendingTabOpens.current.get(tabId);
    if (pending) {
      try { await pending; } catch { /* ignore */ }
    }
    try {
      await invoke("send_message", { message: sendText, tabId });
    } catch (err) {
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Connection error: ${err}`,
        },
        tabId,
      );
      updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
      if (stateRef.current.activeTabId === tabId) setStatusFlags({ status: "error" });
    }
  }

  async function setModel(id: string) {
    const tabId = (stateRef.current.activeTabId as string | undefined) ?? "default";
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "set_model", id, tabId }),
      });
    } catch (err) {
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch model: ${err}`,
        },
        tabId,
      );
    }
  }

  // Intercept events from layout-level components before they reach
  // the agent. The layout speaks A2UI, but a few interactions need to
  // drive native APIs (Tauri IPC for chat send, model picker) — the
  // dispatcher lives in `src/eventRoutes/` and is wired here. Three
  // precedence layers, in order: shell-consent reserved prefixes
  // (security boundary), extension event-routes (extensibility),
  // built-in route table.
  const eventRouteCtx = useMemo<EventRouteContext>(
    () => ({
      setState,
      stateRef,
      extensionEventRoutesRef,
      extensionEventRoutingModeRef,
      allDiscoveredSessionsRef,
      hasPendingShellWriteConsent,
      resolveShellWriteConsent,
      hasPendingShellCloseConsent,
      resolveShellCloseConsent,
      hasPendingSessionDeleteConsent,
      resolveSessionDeleteConsent,
      promptDeleteSessionConfirmation,
      pushNotification,
      dismissNotification,
      sendChat,
      stopPrompt,
      updateActiveTab,
      newTab,
      newShellTab,
      closeTab,
      setActiveTab,
      setActiveSubTab,
      applyShareModeToTab,
      closeSettings,
      applySettingsPatch,
      saveSettings,
      closeSessionSearch,
      setSearchQuery,
      setSearchScope,
      openSearchHit,
      closePalette,
      runPaletteItem,
      toggleTerminal,
      clearChat,
      setModel,
      setTheme,
      activateLayoutById,
      openProjectFromPicker,
      setActiveProjectById,
      removeProjectById,
      syncRecentSessionsToState,
      invoke,
      writeState,
    }),
    // Built once and reused across renders. Every closure inside
    // (sendChat, newTab, …) reads live state via stateRef / setState
    // callbacks; adding them as deps would force the memo to re-build
    // every render — losing any consumer-side memoization keyed on its
    // identity — without changing observed behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onEvent = useMemo(
    () =>
      (
        component: { id: string; type?: string },
        eventType: string,
        data?: unknown,
      ) => dispatchEvent({ component, eventType, data }, eventRouteCtx),
    [eventRouteCtx],
  );

  const renderState = useMemo(() => {
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    const recentSessions =
      (state.recentSessions as RecentSessionItem[] | undefined) ?? [];
    const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
    const history = buildSidebarHistory(
      tabs,
      state.activeTabId as string | undefined,
      recentSessions,
    );
    // Derive the layout's tab-visibility gates from tabs.length so they
    // can never drift out of sync with reality. Code paths that mutate
    // tabs (newTab/closeTab/switchProjectBucket) still write hasTabs/empty
    // for cleanliness, but if any of them ever forget — or set both true
    // (the orphan-active-id case in switchProjectBucket fallthrough) —
    // the visible UI stays consistent.
    const hasTabs = tabs.length > 0;
    return {
      ...state,
      hasTabs,
      empty: !hasTabs,
      sidebar: {
        ...sidebar,
        history,
      },
    };
  }, [buildSidebarHistory, state]);

  return (
    <SkillRegistryProvider registry={registry}>
      <div className="app">
        <A2UIRenderer
          payload={layout}
          state={renderState}
          onStateChange={setState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
        {/* App-root overlays — registry-resolved so a skill can replace any
            of them via aethon.registerComponent("<type>", custom). Each
            overlay gates its own visibility on state (e.g. /commandPalette
            /open), so the renderers stay mounted but render null when
            closed. tabId is forwarded so extension override templates
            route their bridge events against the active pi session. */}
        <RegistryComponent
          type="notification-stack"
          state={renderState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
        <RegistryComponent
          type="command-palette"
          state={renderState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
        <RegistryComponent
          type="settings-panel"
          state={renderState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
        <RegistryComponent
          type="search-panel"
          state={renderState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
      </div>
    </SkillRegistryProvider>
  );
}
