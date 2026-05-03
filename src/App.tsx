import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import A2UIRenderer, { RegistryComponent } from "./components/A2UIRenderer";
import { reconcileFrontendModules } from "./skills/extensionFrontendLoader";
import { SkillRegistry } from "./skills/SkillRegistry";
import { SkillRegistryProvider } from "./skills/registry";
import {
  builtinLayouts,
  defaultLayoutSkill,
  inspectLayoutSlotCoverage,
  layoutSlots,
} from "./skills/default-layout";
import type {
  PaletteItem,
  PaletteMode,
} from "./skills/default-layout/palette-items";
import type {
  NotificationEntry,
  NotificationKind,
} from "./skills/default-layout/notifications";
import type { LayoutCatalogueEntry, SlotCoverageReport } from "./skills/default-layout";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import {
  NO_PROJECT_KEY,
  makeEmptyTab,
  projectBucketKey,
  type ShellMeta,
  type Tab,
} from "./types/tab";
import type { A2UISkill } from "./skills/types";
import { deletePointer, setPointer } from "./utils/jsonPointer";
import { registerGrammar as registerHighlightGrammar } from "./utils/highlight";
import { cycleShareMode } from "./utils/shareMode";
import { shellQuoteAll } from "./utils/shellQuote";
import { extractSessionId } from "./utils/sidebarHistory";
import { deepMergeState, layoutPatch } from "./utils/stateMutation";
import { applyUiScale } from "./utils/viewport";
import { formatRelativeTime } from "./utils/time";
import { canonicalCombo, normalizeRegisteredCombo } from "./utils/keybindings";
import { coerceChatMessages } from "./utils/messages";
import { useZoomAndTheme } from "./hooks/useZoomAndTheme";
import { useShellConsent } from "./hooks/useShellConsent";
import { useProjects } from "./hooks/useProjects";
import { useTabNavigation } from "./hooks/useTabNavigation";
import { useTabs, TAB_MIRROR_KEYS, TERMINAL_REPLAY_MAX } from "./hooks/useTabs";
import { isFocusInTerminalPanel } from "./utils/focus";
import {
  buildBuiltinSlashCommands,
  parseSlashCommand,
  type SlashCommand,
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

interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
}

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
  interface ExtensionTheme {
    id: string;
    label: string;
    vars: Record<string, string>;
  }
  const themesRef = useRef<Map<string, ExtensionTheme>>(new Map());
  // [shell] default_share_mode resolved from ~/.aethon/config.toml. Read
  // once on boot (see the getConfig() effect below) and consulted by
  // newShellTab. Defaults to `"private"` until the config loads — the
  // safest possible seed for new shell tabs.
  const defaultShareModeRef = useRef<ShellMeta["shareMode"]>("private");
  // P4: per-tab turn start timestamps. Set on `prompt_started`, cleared
  // on `response_end`. Used to compute turn duration for the OS
  // completion notification gate.
  const turnStartedAtRef = useRef<Map<string, number>>(new Map());
  // Hang-warn: push a sticky "Still working…" notification if the active tab
  // stays waiting longer than HANG_WARN_MS. Per-tab timers keyed by tabId.
  const HANG_WARN_MS = 30_000;
  // Per-tab notification id so a `response_end` for tab B doesn't dismiss
  // tab A's still-hung warning (codex P2 review feedback).
  const hangWarnNotifId = (tabId: string) => `ae-hang-warn:${tabId}`;
  // Track which tabs currently have a hang notification surfaced so the
  // crash/reload paths can dismiss them all without scanning.
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
  const BUILTIN_THEMES: { id: string; label: string }[] = [
    { id: "ember", label: "Ember — warm dark" },
    { id: "paper", label: "Paper — cream light" },
    { id: "aether", label: "Æther — signature" },
  ];

  // Inject (or replace) the <style> element holding an extension theme's
  // CSS custom properties. Keyed by id so re-registering replaces the
  // previous rule rather than stacking. Values are written via CSSOM
  // `setProperty` (not string interpolation) so a malformed value
  // containing `;` or `}` can't escape the declaration and inject
  // arbitrary rules — the parser silently rejects invalid values
  // instead of letting them leak into the stylesheet.
  function injectThemeStyle(theme: ExtensionTheme) {
    const styleId = `aethon-theme-${theme.id}`;
    let el = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = styleId;
      document.head.appendChild(el);
    }
    // Quote-escape the id for use inside a CSS selector. CSS.escape is
    // widely supported in webviews (Chromium 46+, WebKit 10+); the
    // fallback strips to a slug-safe set when the runtime lacks it.
    const safe = (window.CSS && window.CSS.escape)
      ? window.CSS.escape(theme.id)
      : theme.id.replace(/[^A-Za-z0-9_-]/g, "");
    const sheet = el.sheet;
    if (!sheet) {
      // Stylesheet not attached yet (extremely rare — happens if the
      // <style> is detached). Fall back to attribute writes; the next
      // hydrate will succeed once the sheet is available.
      el.textContent = "";
      return;
    }
    // Replace any prior rules so re-registering with fewer vars drops
    // the obsolete declarations.
    while (sheet.cssRules.length > 0) sheet.deleteRule(0);
    sheet.insertRule(`:root[data-theme="${safe}"] {}`);
    const rule = sheet.cssRules[0] as CSSStyleRule;
    rule.style.setProperty("color-scheme", "dark");
    for (const [k, v] of Object.entries(theme.vars)) {
      // setProperty silently no-ops on invalid values — can't break out.
      rule.style.setProperty(k, v);
    }
  }

  // Apply a fresh themes list — replace the registry, inject CSS for each,
  // and mirror id/label pairs to /sidebar/themes so the sidebar updates.
  // Style tags whose ids no longer appear in the list are removed first so
  // a deleted/disabled extension stops bleeding stale CSS into the page.
  function hydrateThemes(list: ExtensionTheme[]) {
    themesRef.current = new Map(list.map((t) => [t.id, t]));
    const keep = new Set(list.map((t) => `aethon-theme-${t.id}`));
    for (const el of document.querySelectorAll('style[id^="aethon-theme-"]')) {
      if (!keep.has(el.id)) el.remove();
    }
    for (const t of list) injectThemeStyle(t);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      const currentTheme =
        document.documentElement.dataset.theme || BUILTIN_THEMES[0]?.id;
      const themes = [
        ...BUILTIN_THEMES,
        ...list.map((t) => ({ id: t.id, label: t.label })),
      ].map((t) => ({ ...t, active: t.id === currentTheme }));
      return {
        ...prev,
        sidebar: {
          ...sidebar,
          themes,
        },
      };
    });
  }

  // Hydrate the sidebar extensions list from the bridge's loaded/failed sets.
  // Called on `ready` (startup + project switch) so the list always reflects
  // what the current bridge process has actually loaded.
  function hydrateExtensions(
    loaded: { name: string; source: string }[],
    failed: { name: string; source: string; error?: string }[],
  ) {
    const sourceLabel = (s: string) =>
      s === "project-directory" ? "project"
      : s === "global-directory" ? "user"
      : s === "extension-package" ? "package"
      : s;
    const items = [
      { id: "extension-layout", label: "default-layout", hint: "core", active: true },
      ...loaded.map((e) => ({
        id: `ext:${e.name}`,
        label: e.name,
        hint: sourceLabel(e.source),
        active: true,
      })),
      ...failed.map((e) => ({
        id: `ext-failed:${e.name}`,
        label: e.name,
        hint: `${sourceLabel(e.source)} · failed`,
        active: false,
      })),
    ];
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      return { ...prev, sidebar: { ...sidebar, extensions: items } };
    });
  }

  function listThemes(): { id: string; label: string }[] {
    return [
      ...BUILTIN_THEMES,
      ...[...themesRef.current.values()].map((t) => ({ id: t.id, label: t.label })),
    ];
  }

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

  // Global keyboard shortcuts. Bound on the document so they fire regardless
  // of focus; preventDefault + stopPropagation when handled so xterm
  // doesn't also receive the keystroke as input data (otherwise pressing
  // Cmd+` while focused in the terminal both toggles the panel AND types
  // a backtick into the shell).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip auto-repeat (held key) so a brief hold doesn't double-fire.
      if (e.repeat) return;
      // Extension-registered keybindings are checked before built-ins so
      // they can intentionally replace default chrome actions. Dispatch
      // through the existing a2ui_event route as
      // {componentType: "keybinding", componentId: "keybinding__tpl__<combo>",
      //  data: {action, combo}} so a paired aethon.onEvent matcher fires.
      const combo = canonicalCombo(e);
      if (combo) {
        const binding = extensionKeybindingsRef.current.get(combo);
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
            tabId: stateRef.current.activeTabId,
          }).catch(() => {
            /* ignore — bridge gone or webview reload mid-flight */
          });
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      // Cmd+` toggles the bottom terminal panel AND moves focus there
      // when opening (so the user can type immediately). Mirrors
      // VS Code's Ctrl+` behavior. When closing, return focus to the
      // chat composer so typing continues seamlessly.
      if (e.key === "`" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalAndFocus();
        return;
      }
      // Cmd+B toggles the sidebar. Mirrors the standard editor
      // shortcut for showing/hiding sidebars.
      if (e.key.toLowerCase() === "b" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
        return;
      }
      // Cmd+K → clear active chat. This is advertised in the Workstation
      // panels section and mirrors the View > Clear Chat menu item.
      if (e.key.toLowerCase() === "k" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        clearChat();
        return;
      }
      // Cmd+. → stop the current prompt. Mirrors the native menu
      // accelerator and the busy composer Stop button.
      if (e.key === "." && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        void stopPrompt();
        return;
      }
      // Cmd+Shift+T → explicit new shell sub-tab in the bottom panel
      // (M6 restructure). Auto-opens the panel and makes the new shell
      // the active sub-tab. Useful when the user wants a shell without
      // having to focus the bottom panel first.
      if (e.key.toLowerCase() === "t" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        newShellTab();
        return;
      }
      // Cmd+T — focus-aware (M6 restructure):
      //   - focus inside the bottom terminal panel → new shell sub-tab
      //   - focus elsewhere → new agent tab (the pre-P1 default)
      // Matches the user's mental model: "new tab" of whatever surface
      // I'm currently using. Browsers, VS Code, and iTerm all key off
      // the focused surface for "new"-style shortcuts.
      if (e.key.toLowerCase() === "t" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        // Focus inside the bottom terminal panel always opens a shell —
        // Cmd+T is "new tab of whatever surface I'm using". When focus
        // is elsewhere, `[shortcuts] new_tab_kind` lets the user opt
        // into "always open shell" by setting it to "shell"; default
        // ("agent") preserves the focus-aware behaviour.
        if (
          isFocusInTerminalPanel() ||
          shortcutsNewTabKindRef.current === "shell"
        ) {
          newShellTab();
        } else {
          newTab();
        }
        return;
      }
      // Cmd+] → next tab; Cmd+[ → previous. When focus is inside the
      // bottom terminal panel, the same combo cycles between sub-tabs
      // (agent-bash + each shell) so the user navigates the surface
      // they're looking at. Outside the panel → top agent tab strip.
      if (e.key === "]" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) {
          nextShellSubTab(1);
        } else {
          nextTab(1);
        }
        return;
      }
      if (e.key === "[" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) {
          nextShellSubTab(-1);
        } else {
          nextTab(-1);
        }
        return;
      }
      // Cmd+Shift+] / Cmd+Shift+[ → move active tab right / left.
      // Matches Chrome/Firefox tab-reorder shortcut. Wraps at the ends.
      // When focus is inside the bottom terminal panel, the same combo
      // reorders shell sub-tabs instead so the user's mental model
      // ("act on the surface I'm looking at") holds. agent-bash is
      // pinned first and cannot be reordered.
      if (e.key === "}" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) {
          moveActiveShellSubTab(1);
        } else {
          moveActiveTab(1);
        }
        return;
      }
      if (e.key === "{" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isFocusInTerminalPanel()) {
          moveActiveShellSubTab(-1);
        } else {
          moveActiveTab(-1);
        }
        return;
      }
      // Cmd+1..8 → jump to tab N (1-indexed); Cmd+9 → jump to last.
      // Universal across browsers (Chrome / Firefox / Safari) + iTerm2 /
      // Windows Terminal. The first 8 use direct indexing so layouts
      // with > 9 tabs still get keyboard access for the first few; the
      // 9th key is the "last tab" affordance.
      // Cmd+1..8 → jump to agent tab N; Cmd+9 → jump to last agent
      // tab. Filter shells before counting so the indices line up with
      // what the user actually sees in the top strip (codex P2 finding
      // on PR #20: with [agent, agent, shell] the previous code passed
      // index 2 to jumpToTab and no-op'd because the filtered array
      // only has 2 items).
      if (
        mod &&
        !e.shiftKey &&
        !e.altKey &&
        e.key >= "1" &&
        e.key <= "9"
      ) {
        // Focus inside the bottom terminal panel → jump between
        // sub-tabs (idx 0 = agent-bash, 1..N = shell sub-tabs). 9 is
        // "last sub-tab". Outside the panel → jump between agent tabs
        // in the top strip.
        if (isFocusInTerminalPanel()) {
          const shellSubTabs = ((stateRef.current.tabs as Tab[] | undefined) ?? [])
            .filter((t) => t.kind === "shell");
          // total = agent-bash + shellSubTabs.length
          const total = 1 + shellSubTabs.length;
          if (total === 0) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "9") {
            jumpToShellSubTab(total - 1);
          } else {
            jumpToShellSubTab(parseInt(e.key, 10) - 1);
          }
          return;
        }
        const agentTabs = ((stateRef.current.tabs as Tab[] | undefined) ?? [])
          .filter((t) => t.kind !== "shell");
        if (agentTabs.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "9") {
          jumpToTab(agentTabs.length - 1);
        } else {
          jumpToTab(parseInt(e.key, 10) - 1);
        }
        return;
      }
      // Cmd+Opt+T → reopen most-recently-closed tab. Matches iTerm2's
      // restore-closed-window shortcut. macOS lets Option mutate the
      // printable-key value (Opt+T arrives as `e.key === "†"`), so
      // match the *physical* key via `e.code === "KeyT"` whenever Alt
      // is part of the shortcut. Without this the advertised combo
      // silently no-ops on Mac (codex P2 review of PR #17).
      if (
        mod &&
        e.altKey &&
        !e.shiftKey &&
        (e.code === "KeyT" || e.key.toLowerCase() === "t")
      ) {
        e.preventDefault();
        e.stopPropagation();
        reopenLastClosedTab();
        return;
      }
      // Cmd+W → close active tab (no-op on the last/default tab).
      if (e.key.toLowerCase() === "w" && mod && !e.shiftKey && !e.altKey) {
        const activeId = stateRef.current.activeTabId as string | undefined;
        if (!activeId) return;
        e.preventDefault();
        e.stopPropagation();
        closeTab(activeId);
        return;
      }
      // Cmd+Shift+F → cross-session search overlay (M6 P6). Searches
      // every persisted JSONL session under ~/.aethon/sessions/<tabId>/
      // via the Tauri search_sessions command. Click a result → restore
      // the originating tab.
      if (e.key.toLowerCase() === "f" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleSessionSearch();
        return;
      }
      // Cmd+Shift+P → command palette in "commands" mode (run an action,
      // slash command, layout, theme, …). Checked before plain Cmd+P so
      // shift takes precedence — otherwise the lowercase key match would
      // route both to the switcher.
      if (e.key.toLowerCase() === "p" && mod && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        openPalette("commands");
        return;
      }
      // Cmd+P → command palette in "switcher" mode (jump to a tab,
      // session, project, …). Mirrors VS Code's quick-open intuition
      // but extended with the rest of Aethon's surfaces.
      if (e.key.toLowerCase() === "p" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        openPalette("switcher");
        return;
      }
      // Esc closes the palette when it's open. Stays a no-op otherwise
      // so component-level Esc (chat-input cancel, etc.) keeps working.
      if (e.key === "Escape") {
        const palette = stateRef.current.palette as
          | { open?: boolean }
          | undefined;
        if (palette?.open) {
          e.preventDefault();
          e.stopPropagation();
          closePalette();
          return;
        }
      }
      // Cmd+= / Cmd++ zoom in. macOS reports `=` for the unshifted key
      // and `+` for shift+=. Match both so users with either layout get
      // the same behavior (Chrome, VS Code, Slack all do this). Cmd+-
      // zooms out; Cmd+0 resets. Step is 10% per press.
      if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        e.stopPropagation();
        adjustZoom(0.1);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        adjustZoom(-0.1);
        return;
      }
      // Cmd+Shift+0 → reset zoom. Moved off Cmd+0 so that combo can do
      // composer ↔ terminal focus toggle (more discoverable than reset
      // zoom, which is rare).
      if (mod && !e.altKey && e.shiftKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        resetZoom();
        return;
      }
      // Cmd+0 → toggle focus between the chat composer and the bottom
      // terminal panel. Mirrors VS Code's Cmd+J / Cmd+1 split-pane
      // focus-toggle pattern but bound to a more discoverable key. If
      // the panel is closed, opens it first.
      if (mod && !e.altKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        toggleFocusComposerTerminal();
        return;
      }
      // Cmd+, → open Settings panel (M6 P3). macOS-native Preferences
      // shortcut. Toggles closed if already open.
      if (mod && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        toggleSettings();
        return;
      }
      // Cmd+L → focus the active tab's primary input. Per-context jump
      // (vs. Cmd+0's toggle): agent tab → composer, shell tab → that
      // shell's xterm. When the active tab is an agent but focus is
      // currently in the bottom panel, also opens the panel toggle so
      // the user is never confused about where the cursor went.
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        focusActiveContextInput();
        return;
      }
      // Cmd+Ctrl+F (mac) / F11 (others) → toggle window fullscreen.
      // The native menu also exposes the system fullscreen item; both
      // funnel through the Rust `toggle_fullscreen` command so behaviour
      // stays in sync. F11 is recognised by `e.key === "F11"`; on mac
      // Cmd+Ctrl+F is the system convention.
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
      // Cmd+Shift+S → export active agent chat as Markdown to
      // ~/Downloads/. No-op on shell tabs (chat history doesn't apply).
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void exportActiveChatMarkdown();
        return;
      }
      // F12 → toggle WebKit DevTools. Debug builds only — release
      // builds get a "not available" toast from the Rust command. The
      // function key is unmodified so it doesn't collide with text
      // input; we only swallow it when the user is at the document
      // level rather than typing into a contenteditable.
      if (e.key === "F12") {
        e.preventDefault();
        e.stopPropagation();
        invoke("toggle_devtools").catch((err: unknown) => {
          // Surface the release-build "not available" path inline so
          // the user knows why nothing happened.
          pushNotification({
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
    // useCapture=true so we run BEFORE xterm's keydown listener;
    // stopPropagation then keeps the keystroke out of the shell.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = {
      setLayout,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      getLayout: () => layout,
      registerSkill: (skill: A2UISkill) => {
        registry.register(skill);
        if (skill.layout) setLayout(skill.layout);
      },
      listSkills: () => registry.list().map((s) => s.name),
      newTab,
      closeTab,
      switchTab: setActiveTab,
      listTabs: () => ((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => ({
        id: t.id,
        label: t.label,
        active: t.id === stateRef.current.activeTabId,
      })),
      // Layout catalogue. Lets the user / agent swap between named
      // layouts (workstation only, today) without having to ship a full
      // setLayout payload. Extensions append more via registerLayout.
      // Activation goes through setLayout so all the existing
      // state-merge / layout-bound-state semantics apply.
      listLayouts: (): LayoutCatalogueEntry[] =>
        layoutCatalogueRef.current.slice(),
      activateLayout: activateLayoutById,
      registerLayout: (entry: LayoutCatalogueEntry): boolean => {
        if (!entry || typeof entry.id !== "string" || !entry.payload) return false;
        const idx = layoutCatalogueRef.current.findIndex((l) => l.id === entry.id);
        if (idx >= 0) {
          layoutCatalogueRef.current[idx] = entry;
        } else {
          layoutCatalogueRef.current.push(entry);
        }
        // Mirror into state so /layout's argSource picker re-resolves.
        setState((prev) => ({
          ...prev,
          layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
            id: l.id,
            label: l.name,
            description: l.description,
          })),
        }));
        return true;
      },
      // Layout-slot catalogue. The contract (canonical slot names + which
      // composite typically fills each) is `src/skills/default-layout/slots.json`.
      // A composite uses `area: "<slot>"` to declare placement; an alternative
      // layout that wants to host the standard composites needs to either
      // call its grid areas by these names, or provide a `slotMap` prop on
      // its root <layout>.
      layoutSlots,
      inspectLayoutSlotCoverage: (payload?: A2UIPayload): SlotCoverageReport =>
        inspectLayoutSlotCoverage(payload ?? layout),
      // Projects — directories the agent works in. `pickProject` opens a
      // native folder picker; the resolved path is persisted, made
      // active, and announced to the bridge as the new tab cwd. Returns
      // null on cancel. `openProject(path)` skips the picker for paths
      // that are already known (e.g. the empty-state "Recent projects"
      // list). `setActiveProject(id)` switches the active project for
      // future tabs without opening one. `clearProject()` reverts to
      // bridge-default cwd.
      pickProject: openProjectFromPicker,
      openProject: (path: string, label?: string) => openProjectByPath(path, label),
      setActiveProject: setActiveProjectById,
      clearProject: clearActiveProject,
      removeProject: removeProjectById,
      listProjects: () => projectsRef.current.projects.slice(),
      activeProject: () => activeProject(projectsRef.current),
      // Extension surface for the `code` primitive's syntax highlighter.
      // Mirrors the bridge-side aethon.registerHighlightGrammar so a
      // frontend skill module (loaded via skill `frontendEntry`) can
      // teach Shiki a new language without an IPC round-trip. Bridge
      // extensions go through `register_highlight_grammar` IPC instead.
      registerHighlightGrammar: (lang: string, grammar: unknown): boolean => {
        if (typeof lang !== "string" || lang.trim().length === 0) return false;
        if (!grammar || typeof grammar !== "object") return false;
        registerHighlightGrammar(lang.trim(), grammar);
        return true;
      },
    };
    (window as unknown as { aethon: typeof api }).aethon = api;

    if (import.meta.env.DEV) {
      const win = window as unknown as {
        __AETHON_STATE__: () => Record<string, unknown>;
        __AETHON_REGISTRY__: SkillRegistry;
        __AETHON_SET_STATE__: (next: Record<string, unknown>) => void;
      };
      win.__AETHON_STATE__ = () => stateRef.current;
      win.__AETHON_REGISTRY__ = registry;
      win.__AETHON_SET_STATE__ = setState;
    }
    // The api closures intentionally read live state via stateRef /
    // setState callbacks, so a stale reference inside `api` doesn't
    // produce stale data. Adding the function deps would re-build this
    // effect every render and churn `window.aethon` for no behavioral
    // gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, registry]);

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
    (async () => {
      try {
        await invoke("start_agent");
        // Tell the bridge what layout we actually booted with so extensions
        // calling api.getLayout() at register-time see a meaningful tree
        // instead of null. The bridge stores it as `bootLayout` and
        // _getLayout() folds it with any pending patches. Sent before
        // `report` so the snapshot the bridge ships back includes it.
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "boot_layout", payload: BOOT_LAYOUT }),
        });
        // Request a fresh `ready` event in case the agent process was already
        // running before this React tree mounted (e.g. after a webview
        // hot-reload). Newly-spawned agents emit ready unconditionally, so
        // the duplicate is harmless.
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "report" }),
        });
      } catch (err) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to start agent: ${err}`,
        });
        setStatusFlags({ status: "error" });
      }
    })();

    const unlistenResponse = listen<string>("agent-response", (event) => {
      try {
        const data = JSON.parse(event.payload);
        handleAgentMessage(data);
      } catch {
        // Non-JSON line from the bridge — ignore.
      }
    });

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
      unlistenResponse.then((fn) => fn());
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

  // Ack a mutation back to the bridge so the awaiting Promise resolves.
  // Called from every mutation case in handleAgentMessage that successfully
  // applied (or rejected) the change. Fire-and-forget — we don't await the
  // ack-send because the bridge ack channel is independent of any other
  // outgoing message.
  function ackMutation(
    mutationId: unknown,
    success: boolean,
    error?: string,
    data?: unknown,
  ) {
    if (typeof mutationId !== "string" || mutationId.length === 0) return;
    invoke("agent_command", {
      payload: JSON.stringify({
        type: "mutation_ack",
        mutationId,
        success,
        ...(error ? { error } : {}),
        ...(data !== undefined ? { data } : {}),
      }),
    }).catch(() => {
      /* bridge gone — extension's awaiter will hit the timeout instead */
    });
  }

  function handleAgentMessage(data: { type?: string; [k: string]: unknown }) {
    switch (data.type) {
      case "ready": {
        const model = (data.model as string) || "";
        // Cache pi's default model so new tabs created before `ready` fires
        // (or before a session's model initialises) can inherit it immediately
        // instead of showing blank "model ▼".
        if (model) piDefaultModelRef.current = model;
        const models = (data.models as ModelDescriptor[]) ?? [];
        // Hydrate any extension-registered component templates the bridge
        // discovered at boot. setTemplates is wholesale (bridge is the
        // source of truth) so reload-after-restart picks up the same set.
        const extComponents = (data.extensionComponents as
          | Record<string, unknown>
          | undefined) ?? {};
        const extState = (data.extensionState as
          | Record<string, unknown>
          | undefined) ?? {};
        const extLayout = data.extensionLayout as A2UIPayload | undefined;
        const extPatches = (data.extensionLayoutPatches as
          | { path: string; value: unknown }[]
          | undefined) ?? [];
        const extThemes = (data.extensionThemes as ExtensionTheme[] | undefined) ?? [];
        const extSlash = (data.extensionSlashCommands as
          | { name: string; description: string; usage?: string }[]
          | undefined) ?? [];
        const extKeys = (data.extensionKeybindings as
          | { combo: string; action: string; description?: string }[]
          | undefined) ?? [];
        const extMenu = (data.extensionMenuItems as
          | {
              id: string;
              label: string;
              action: string;
              location: "app" | "tray";
              parent?: string;
            }[]
          | undefined) ?? [];
        const extEventRoutes = (data.extensionEventRoutes as
          | { componentId?: string; eventType?: string }[]
          | undefined) ?? [];
        const extEventRoutingMode =
          data.extensionEventRoutingMode === "extension" ? "extension" : "builtin";
        const extLayouts = (data.extensionLayouts as
          | {
              id: string;
              name: string;
              description?: string;
              payload: A2UIPayload;
            }[]
          | undefined) ?? [];
        const extFrontendModules = (data.extensionFrontendModules as
          | { name: string; code: string }[]
          | undefined) ?? [];
        const extStateKeys = ((data.extensionStateKeys as string[] | undefined) ?? []);
        const discTabs = (data.discoveredTabs as DiscoveredSession[] | undefined) ?? [];
        allDiscoveredSessionsRef.current = discTabs;
        // Hydrate extension themes BEFORE the layout state merge below so
        // /sidebar/themes carries the full list (built-ins + extension)
        // when the merge runs. hydrateThemes also injects the CSS so a
        // saved choice has the rule available before data-theme is read.
        hydrateThemes(extThemes);
        hydrateExtensions(
          (data.extensionsList as { name: string; source: string }[] | undefined) ?? [],
          (data.failedExtensionsList as { name: string; source: string; error?: string }[] | undefined) ?? [],
        );
        registry.setTemplates(extComponents);
        // Restore extension-registered slash commands so the picker shows
        // them on first paint (no need to wait for an extension_slash_commands
        // delta after reload). hydrateSlashCommands rewrites the merged
        // catalog (built-ins + extensions), updates the picker state ref,
        // and bumps /slashCommands so the picker re-resolves via $ref.
        hydrateSlashCommands(extSlash);
        hydrateKeybindings(extKeys);
        hydrateEventRoutes(extEventRoutes, extEventRoutingMode);
        hydrateExtensionLayouts(extLayouts);
        hydrateFrontendModules(extFrontendModules);
        // Push the persisted menu list into Tauri so the native menu
        // is correct on first paint after webview reload. Errors are
        // logged but non-fatal — the menu falls back to built-ins-only.
        if (extMenu.length > 0) {
          invoke("set_extension_menu_items", { items: extMenu }).catch(
            (err: unknown) => {
              console.warn("[menu] set_extension_menu_items failed:", err);
            },
          );
        }
        // Surface discovered persistent sessions in the empty-state's
        // recent-sessions list. Filter out tabIds we already have local
        // records for so the same session isn't listed twice (open AND
        // restorable). Format the lastModified into a "10m ago"-style
        // label for the row's right-hand meta.
        const knownIds = knownTabIds((data.tabs as { id: string }[] | undefined) ?? []);
        const scopedDiscTabs = scopedDiscoveredSessions(discTabs);
        const recentSessions = recentSessionItems(scopedDiscTabs, knownIds);
        if (projectsLoadedRef.current) {
          autoRestoreDiscoveredSessions(scopedDiscTabs, knownIds);
        }
        // Restore any extension-supplied layout, then replay queued
        // patches. Falls back to the boot layout when none is reported
        // so a removed/disabled extension stops bleeding stale chrome
        // across agent reloads. The layout's own `state` hydrates below
        // alongside extensionState — same semantics as the live
        // `layout_set` path so replay matches.
        const baseLayout: A2UIPayload =
          extLayout &&
          typeof extLayout === "object" &&
          Array.isArray(extLayout.components)
            ? extLayout
            : BOOT_LAYOUT;
        const patchedLayout = extPatches.reduce<A2UIPayload>(
          (acc, p) => layoutPatch(acc, p.path, p.value),
          baseLayout,
        );
        setLayout(patchedLayout);
        // Snapshot the prune set BEFORE the setState callback so the side
        // effect of updating lastExtensionStateKeysRef can stay outside
        // setState — otherwise concurrent-mode re-runs of the callback
        // would update the ref multiple times and race with the next
        // ready's read. Compute willPrune (= prev set − new set) here
        // and freeze it for the duration of this handler.
        const willPruneKeys: string[] = [];
        for (const stale of lastExtensionStateKeysRef.current) {
          if (!extStateKeys.includes(stale)) willPruneKeys.push(stale);
        }
        // Update the ref BEFORE calling setState so the next ready (which
        // may arrive in the same React batch) sees the new "previous" set.
        lastExtensionStateKeysRef.current = new Set(extStateKeys);
        setState((prev) => {
          // Three-layer hydration in priority order (lowest → highest):
          //   1. extension layout state — TREATED AS BOOT DEFAULTS
          //      (only fills keys not already set; existing live state
          //      like `messages` / `canvas` wins to avoid wiping
          //      restored history when ready replays after a reload)
          //   2. extension setState patches (last-write-wins overrides)
          //   3. ready-owned runtime fields (model picker, status, etc.)
          //
          // Stale-key pruning: drop paths the previous ready tracked but
          // this ready dropped (an extension was uninstalled). Without
          // this, `prev` keeps the leftover slice forever (deepMerge
          // doesn't remove keys, only adds/updates). The willPruneKeys
          // diff was captured outside this callback so it's stable
          // across concurrent-mode re-runs.
          let next: Record<string, unknown> = { ...prev };
          for (const stale of willPruneKeys) {
            next = deletePointer(next, stale);
          }
          if (extLayout && extLayout.state) {
            // Defaults semantics: deep-merge layout into a fresh object
            // and let prev win for any overlapping keys.
            next = deepMergeState(
              extLayout.state,
              next,
            );
          }
          next = deepMergeState(next, extState);
          // Reconcile our local tabs with the bridge's reported tabs.
          // Two cases:
          //   (a) webview reload while bridge is alive — bridge has tabs
          //       we don't know about; create local records for them so
          //       the user can re-access those sessions.
          //   (b) bridge restart — local has tabs the bridge doesn't;
          //       the post-ready replay below re-establishes them.
          //
          // Also hydrate per-tab mirrored state from extensionTabState
          // — those values are the bridge's record of what extensions /
          // agents wrote to /canvas, /messages, etc. for each tab. On a
          // webview reload they're the only way to restore tab UI state
          // that was driven by the agent (React state didn't survive).
          {
            const localTabs = ((next.tabs as Tab[] | undefined) ?? []).slice();
            const bridgeTabs =
              (data.tabs as { id: string; model: string }[] | undefined) ?? [];
            const tabReplay =
              (data.extensionTabState as Record<string, Record<string, unknown>> | undefined) ?? {};
            const dIdx = localTabs.findIndex((t) => t.id === "default");
            if (dIdx >= 0) {
              localTabs[dIdx] = { ...localTabs[dIdx], model };
            }
            // Backfill any tab that has no model yet (e.g. opened before
            // ready fired) with pi's default so the picker is never blank.
            for (let i = 0; i < localTabs.length; i++) {
              if (!localTabs[i].model && model) {
                localTabs[i] = { ...localTabs[i], model };
              }
            }
            for (const bt of bridgeTabs) {
              if (bt.id === "default") continue;
              const exists = localTabs.find((t) => t.id === bt.id);
              if (exists) {
                if (!exists.model && bt.model) {
                  const idx = localTabs.indexOf(exists);
                  localTabs[idx] = { ...exists, model: bt.model };
                }
                continue;
              }
              const label = `Tab ${localTabs.length + 1}`;
              localTabs.push({
                ...makeEmptyTab(bt.id, label, projectsRef.current.activeId),
                model: bt.model,
              });
            }
            // Apply the bridge's per-tab replay over each tab record.
            // prev wins for keys the React side already restored (e.g.
            // local-only message history) — agent-driven canvas /
            // model fills the gaps.
            for (let i = 0; i < localTabs.length; i++) {
              const replay = tabReplay[localTabs[i].id];
              if (!replay) continue;
              const merged = { ...localTabs[i] } as unknown as Record<string, unknown>;
              for (const [k, v] of Object.entries(replay)) {
                // Only fill keys that aren't already populated locally,
                // so a real local update beats a possibly-stale replay.
                if (merged[k] === undefined || merged[k] === null ||
                    (Array.isArray(merged[k]) && (merged[k] as unknown[]).length === 0) ||
                    merged[k] === "") {
                  merged[k] = v;
                }
              }
              localTabs[i] = merged as unknown as Tab;
            }
            next.tabs = localTabs;
          }
          // The model + sidebar mirror tracks the ACTIVE tab, not the
          // default — so a `ready` arriving while a non-default tab is
          // active doesn't clobber the visible selection. Look up the
          // active tab's model in the just-updated tabs array; fall
          // back to data.model on first boot when no tab record exists.
          const activeId = (next.activeTabId as string | undefined) ?? "default";
          const tabsList = (next.tabs as Tab[] | undefined) ?? [];
          const activeTab = tabsList.find((t) => t.id === activeId);
          const activeModel = activeTab?.model || model;
          next = {
            ...next,
            model: activeModel,
            status: "ready",
            connection: "connected",
            recentSessions,
            sidebar: {
              ...((next.sidebar) ?? {}),
              models: models.map((m) => ({
                id: m.id,
                label: m.label,
                active: m.id === activeModel,
              })),
            },
          };
          // Re-mirror the active tab's full state to the root keys.
          // Without this, ready-replayed values for /messages, /canvas,
          // etc. live only on the tab record but the layout binds via
          // the root mirror, so the user wouldn't see the restored
          // state until they switched tabs and back.
          if (activeTab) {
            const tabRec = activeTab as unknown as Record<string, unknown>;
            for (const key of TAB_MIRROR_KEYS) {
              next[key as string] = tabRec[key as string];
            }
          }
          return next;
        });
        // Re-establish bridge sessions for any non-default local tabs the
        // user created before the agent reloaded. The bridge starts fresh
        // each spawn — without this, prompts on those tabs would hit a
        // tab the bridge has never seen and fail. After the session is
        // open, also restore the tab's previously-selected model so the
        // user doesn't silently send the next prompt to pi's default.
        const localTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        for (const t of localTabs) {
          if (t.id === "default") continue;
          // Pass `model` so the new bridge session boots with the same
          // model the user previously selected — no race window.
          // Track in pendingTabOpens so a fast first chat on the
          // restored tab waits for the bridge to register the session
          // (otherwise send_message would race tab_open and lazily
          // create the tab without the inherited model).
          // Same cwd inheritance as newTab — restored sessions land in the
          // currently-active project unless they were opened before any
          // project was set. The bridge dedupes paths internally, so a
          // re-announce on existing tabs with the same cwd is a no-op.
          const restoredCwd = activeProject(projectsRef.current)?.path;
          const opening = invoke("agent_command", {
            payload: JSON.stringify({
              type: "tab_open",
              tabId: t.id,
              ...(t.model ? { model: t.model } : {}),
              ...(restoredCwd ? { cwd: restoredCwd } : {}),
            }),
          });
          pendingTabOpens.current.set(t.id, opening);
          opening
            .catch(() => {
              /* surfaced on next chat send */
            })
            .finally(() => {
              pendingTabOpens.current.delete(t.id);
            });
        }
        // Post-respawn project re-announce. The bridge boots with
        // process.cwd() — which is whatever directory bun was launched
        // from, NOT necessarily the user's active project. If we don't
        // re-announce, a hot-reload triggered while a non-cwd project
        // is active leaves the wrong project's extensions loaded. The
        // loop above only sends tab_open for non-default tabs, so when
        // the active tab IS "default" (common: single-tab session)
        // nothing announces. Send an explicit set_project for the
        // active tab so the bridge swaps to the right project. The
        // bridge short-circuits when cwd matches its currentProjectCwd
        // so this is harmless on a fresh boot where the boot effect
        // already announced.
        const activeProj = activeProject(projectsRef.current);
        if (activeProj) {
          const activeTabId =
            (stateRef.current.activeTabId as string | undefined) ?? "default";
          announceProjectToBridge(activeTabId, activeProj.path);
        }
        break;
      }
      case "extension_components": {
        const components = (data.components as Record<string, unknown>) ?? {};
        registry.setTemplates(components);
        ackMutation(data.mutationId, true);
        break;
      }
      case "shell_query": {
        // Bridge proxy for `aethon.shells.{list, read, write}`. Mode
        // changes go through the status-bar badge (frontend invokes
        // `shell_set_share_mode` directly), never through the agent
        // surface; otherwise an extension could flip a private tab into
        // sharing without a user gesture and bypass the opt-in boundary.
        //
        // For write: we check share mode here (read-write → overlay
        // confirm; read-write-trusted → write directly; private/read →
        // refuse), then invoke the Rust shell_write which gates again
        // as defense-in-depth.
        const op = data.op as string | undefined;
        const args = (data.args as Record<string, unknown> | undefined) ?? {};
        const mid = data.mutationId;
        const route = async (): Promise<unknown> => {
          if (op === "list") {
            return await invoke("shell_list_shareable");
          }
          if (op === "read") {
            return await invoke("shell_read_scrollback", { args });
          }
          if (op === "write") {
            return await routeShellWrite(args);
          }
          throw new Error(`unknown shell_query op: ${op}`);
        };
        route()
          .then((result) => ackMutation(mid, true, undefined, result))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ackMutation(mid, false, msg);
          });
        break;
      }
      case "extension_themes": {
        const themes = (data.themes as ExtensionTheme[] | undefined) ?? [];
        hydrateThemes(themes);
        ackMutation(data.mutationId, true);
        break;
      }
      case "register_highlight_grammar": {
        // Extension surface for the `code` primitive: a TextMate grammar
        // for a language Shiki doesn't ship by default. Forward to the
        // worker; it overwrites any prior grammar for the same lang and
        // a follow-up highlight request picks it up. Bridge already
        // validated lang + grammar shape, so we trust the payload here.
        const lang = data.lang as string | undefined;
        const grammar = data.grammar;
        if (typeof lang === "string" && grammar) {
          registerHighlightGrammar(lang, grammar);
          ackMutation(data.mutationId, true);
        } else {
          ackMutation(data.mutationId, false, "register_highlight_grammar: bad payload");
        }
        break;
      }
      case "extension_slash_commands": {
        const list = (data.commands as
          | { name: string; description: string; usage?: string }[]
          | undefined) ?? [];
        hydrateSlashCommands(list);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_keybindings": {
        const list = (data.bindings as
          | { combo: string; action: string; description?: string }[]
          | undefined) ?? [];
        hydrateKeybindings(list);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_event_routes": {
        const list = (data.routes as
          | { componentId?: string; eventType?: string }[]
          | undefined) ?? [];
        const mode = data.mode === "extension" ? "extension" : "builtin";
        hydrateEventRoutes(list, mode);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_layouts": {
        const list = (data.layouts as
          | {
              id: string;
              name: string;
              description?: string;
              payload: A2UIPayload;
            }[]
          | undefined) ?? [];
        hydrateExtensionLayouts(list);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_frontend_modules": {
        const list = (data.modules as
          | { name: string; code: string }[]
          | undefined) ?? [];
        hydrateFrontendModules(list);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_menu_items": {
        const list = (data.items as
          | {
              id: string;
              label: string;
              action: string;
              location: "app" | "tray";
              parent?: string;
            }[]
          | undefined) ?? [];
        // Forward to Tauri so the native menu rebuilds. Ack on success
        // (rebuild) or failure (rare — usually means a malformed item
        // slipped through validation).
        invoke("set_extension_menu_items", { items: list })
          .then(() => ackMutation(data.mutationId, true))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            ackMutation(
              data.mutationId,
              false,
              `frontend_rejected: set_extension_menu_items ${message}`,
            );
          });
        break;
      }
      case "state_patch": {
        // An extension pushed a state mutation. Two cases:
        //
        //   1. Path is a per-tab mirrored key (messages / draft / waiting
        //      / queueCount / canvas / model):
        //      - With data.tabId: route ONLY to that tab. updateTab will
        //        also write to root if it happens to be the active tab.
        //        Don't pre-mirror to root — that would briefly clobber
        //        the active tab's view with a background tab's state.
        //      - Without data.tabId: global setState with no tab context
        //        (clock interval, polling extension). Apply to the active
        //        tab so the layout sees it and a switch-back re-mirrors.
        //   2. Path is global (anything else, e.g. /sidebar/...,
        //      /counter/value, /custom): write directly to root state.
        //      No tab-scoping needed — these aren't mirrored.
        const path = data.path as string | undefined;
        if (!path) {
          ackMutation(data.mutationId, false, "missing path");
          break;
        }
        const segs = path.split("/").filter(Boolean);
        const top = segs[0] as keyof Tab | undefined;
        const isMirrored = top !== undefined && TAB_MIRROR_KEYS.includes(top);
        if (isMirrored) {
          const writeIntoTab = (tab: Tab): Tab => {
            const tabRec = { ...tab } as unknown as Record<string, unknown>;
            if (segs.length === 1) {
              tabRec[top as string] = data.value;
            } else {
              const before = tabRec[top as string];
              const baseObj =
                typeof before === "object" && before !== null
                  ? (before as Record<string, unknown>)
                  : {};
              const nested = setPointer(baseObj, "/" + segs.slice(1).join("/"), data.value);
              tabRec[top as string] = nested;
            }
            return tabRec as unknown as Tab;
          };
          const sourceTabId = data.tabId as string | undefined;
          if (sourceTabId) {
            updateTab(sourceTabId, writeIntoTab);
          } else {
            updateActiveTab(writeIntoTab);
          }
        } else {
          setState((prev) => setPointer(prev, path, data.value));
          // Track this path as extension-owned so the next `ready` knows
          // to prune it if the extension that wrote it is gone. Without
          // this, paths written via setState AFTER the last ready would
          // never appear in lastExtensionStateKeysRef and would survive
          // an extension uninstall as stale UI. (Codex review.)
          lastExtensionStateKeysRef.current.add(path);
        }
        ackMutation(data.mutationId, true);
        break;
      }
      case "layout_set": {
        // Extension swapped the active layout wholesale. Goes through
        // the same path window.aethon.setLayout uses so the new payload
        // hydrates state and renders identically to a default-layout boot.
        const next = data.payload as A2UIPayload | undefined;
        if (!next || typeof next !== "object" || !Array.isArray(next.components)) {
          ackMutation(data.mutationId, false, "payload missing components[]");
          break;
        }
        setLayout(next);
        if (next.state) {
          // Layout state contributes BOOT DEFAULTS — only fills keys
          // that aren't already set in live state. Existing runtime
          // fields (status, model, connection, sidebar.models, …) win.
          // Achieved by deep-merging with prev as the override layer.
          setState((prev) =>
            deepMergeState(next.state as Record<string, unknown>, prev),
          );
        }
        ackMutation(data.mutationId, true);
        break;
      }
      case "layout_patch": {
        // Extension mutated a path inside the active layout (e.g. add a
        // sidebar section, swap a child). Immutable patch that preserves
        // arrays — the generic setPointer collapses arrays into plain
        // objects on traversal because it spreads with `{...existing}`,
        // which would crash the renderer on `components.map()`. Walk
        // manually here so arrays stay arrays.
        const path = data.path as string | undefined;
        if (!path) {
          ackMutation(data.mutationId, false, "missing path");
          break;
        }
        setLayout((prev) => layoutPatch(prev, path, data.value));
        ackMutation(data.mutationId, true);
        break;
      }
      case "model_changed": {
        // Per-tab model change. Bridge tags with tabId; default for legacy.
        const model = (data.model as string) || "";
        const tabId = (data.tabId as string | undefined) ?? "default";
        updateTab(tabId, (tab) => ({ ...tab, model }));
        // Sidebar model picker is global — reflects the active tab's model.
        // (When a non-active tab changes model, we leave the picker alone
        // so the user's currently visible context isn't surprised by it.)
        if (stateRef.current.activeTabId === tabId) {
          setState((prev) => {
            const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
            const items =
              (sidebar.models as { id: string; label: string }[] | undefined) ?? [];
            return {
              ...prev,
              status: `switched to ${model}`,
              sidebar: {
                ...sidebar,
                models: items.map((m) => ({
                  id: m.id,
                  label: m.label,
                  active: m.id === model,
                })),
              },
            };
          });
        }
        break;
      }
      case "tab_ready": {
        // Bridge confirms a per-tab pi session is up and tells us its
        // chosen model. Update the tab record so the sidebar can reflect
        // it on next switch. If the tab is currently active, also refresh
        // the model picker's `active` flag now (otherwise it'd lag until
        // the user manually switched).
        const tabId = (data.tabId as string | undefined) ?? "default";
        const model = (data.model as string) ?? "";
        updateTab(tabId, (tab) => ({ ...tab, model }));
        if (stateRef.current.activeTabId === tabId) {
          setState((prev) => ({
            ...prev,
            sidebar: recomputeModelPicker(
              prev.sidebar as Record<string, unknown> | undefined,
              model,
            ),
          }));
        }
        break;
      }
      case "session_history": {
        const tabId = (data.tabId as string | undefined) ?? "default";
        const messages = coerceChatMessages(data.messages);
        updateTab(tabId, (tab) => ({ ...tab, messages }));
        syncRecentSessionsToState();
        break;
      }
      case "tab_closed": {
        // Bridge confirms a tab session was torn down. We may have already
        // removed it from local state in the close handler; this is just a
        // signal in case some other path triggered the close.
        const tabId = data.tabId as string | undefined;
        if (!tabId) break;
        let nextBuffer = "";
        let switched = false;
        setState((prev) => {
          const tabs = ((prev.tabs as Tab[] | undefined) ?? []).filter((t) => t.id !== tabId);
          if (tabs.length === 0) return prev; // shouldn't happen — bridge refuses to close default
          let activeTabId = prev.activeTabId as string | undefined;
          if (activeTabId === tabId) {
            activeTabId = tabs[tabs.length - 1].id;
            switched = true;
          }
          const result: Record<string, unknown> = { ...prev, tabs, activeTabId };
          const target = tabs.find((t) => t.id === activeTabId)!;
          nextBuffer = target.terminalBuffer ?? "";
          const targetRec = target as unknown as Record<string, unknown>;
          for (const key of TAB_MIRROR_KEYS) {
            result[key as string] = targetRec[key as string];
          }
          result.sidebar = recomputeModelPicker(
            prev.sidebar as Record<string, unknown> | undefined,
            target.model,
          );
          return result;
        });
        if (switched) dispatchTerminalReplay(nextBuffer);
        break;
      }
      case "response_delta": {
        const delta = (data.content as string) ?? "";
        if (!delta) break;
        const messageId = (data.messageId as string) || undefined;
        const tabId = (data.tabId as string | undefined) ?? "default";
        appendOrAmendAgentText(delta, messageId, tabId);
        break;
      }
      case "prompt_started": {
        // Bridge tells us a prompt has begun. Sent for handler-driven
        // ctx.pi.prompt AND every queue-drained turn (source: "queue")
        // so Stop stays visible across followUp boundaries instead of
        // flashing back to Send between turns. The remaining queue count
        // rides along so the input badge stays accurate. tabId routes
        // status to one tab; status bar text only flips for the active.
        const tabId = (data.tabId as string | undefined) ?? "default";
        const remaining = (data.queued as number | undefined) ?? undefined;
        // Record turn start so response_end can compute duration and
        // decide whether to fire the OS completion notification (P4).
        turnStartedAtRef.current.set(tabId, Date.now());
        updateTab(tabId, (tab) => ({
          ...tab,
          waiting: true,
          ...(remaining !== undefined ? { queueCount: remaining } : {}),
        }));
        if (stateRef.current.activeTabId === tabId) {
          setState((prev) => ({ ...prev, status: "thinking…" }));
        }
        // Start hang-warn timer. Reset if a queue-drained prompt_started
        // fires for the same tab (the 30s clock restarts on each new turn).
        {
          const prev = hangWarnTimersRef.current.get(tabId);
          if (prev !== undefined) clearTimeout(prev);
          const handle = setTimeout(() => {
            hangWarnTimersRef.current.delete(tabId);
            const cur = stateRef.current;
            if ((cur.activeTabId as string | undefined) !== tabId) return;
            const tabs = (cur.tabs as Tab[] | undefined) ?? [];
            const tab = tabs.find((t) => t.id === tabId);
            if (!tab?.waiting) return;
            hangWarnActiveRef.current.add(tabId);
            pushNotification({
              id: hangWarnNotifId(tabId),
              title: "Still working…",
              message: "The agent is taking longer than expected.",
              kind: "warning",
              durationMs: null,
              actions: [
                { label: "Stop", action: `hang-warn:stop:${tabId}` },
                { label: "Force restart", action: "hang-warn:force-restart" },
              ],
            });
          }, HANG_WARN_MS);
          hangWarnTimersRef.current.set(tabId, handle);
        }
        break;
      }
      case "queued": {
        // A new chat IPC arrived while a prompt was in flight; pi
        // accepted it into the followUp queue. Bump the per-tab counter.
        const tabId = (data.tabId as string | undefined) ?? "default";
        updateTab(tabId, (tab) => ({ ...tab, queueCount: tab.queueCount + 1 }));
        break;
      }
      case "queue_reset": {
        // Bridge dropped this tab's pi follow-up queue (typically on
        // Stop). Mirror by zeroing the local queueCount so the next
        // response_end clears `waiting` instead of staying stuck on
        // the "queue > 0 keeps Stop" gate.
        const tabId = (data.tabId as string | undefined) ?? "default";
        updateTab(tabId, (tab) => ({ ...tab, queueCount: 0 }));
        break;
      }
      case "response_end": {
        activeResponseIdRef.current = null;
        const tabId = (data.tabId as string | undefined) ?? "default";
        // Only clear waiting when the queue is actually empty. If pi has
        // a followUp queued, it will fire agent_start → prompt_started
        // immediately after this and re-flip waiting; clearing here
        // would cause a Send-flash.
        updateTab(tabId, (tab) => {
          if (tab.queueCount > 0) return tab;
          return { ...tab, waiting: false };
        });
        if (stateRef.current.activeTabId === tabId) {
          setState((prev) => {
            const q = (prev.queueCount as number) ?? 0;
            if (q > 0) return prev;
            return { ...prev, status: "ready" };
          });
        }
        // Clear the hang-warn timer and dismiss this tab's notification
        // (if it appeared). Per-tab id so an unrelated tab's response_end
        // doesn't dismiss a still-hung tab's warning.
        {
          const h = hangWarnTimersRef.current.get(tabId);
          if (h !== undefined) { clearTimeout(h); hangWarnTimersRef.current.delete(tabId); }
          if (hangWarnActiveRef.current.delete(tabId)) {
            dismissNotification(hangWarnNotifId(tabId));
          }
        }
        // P4: fire native OS notification when an agent turn completes
        // while the window is unfocused (or the originating tab isn't
        // active). Only for "real" turns (≥ notifyMinDurationSeconds)
        // and only if the user hasn't disabled via [ui] notify_on_completion.
        const startedAt = turnStartedAtRef.current.get(tabId);
        turnStartedAtRef.current.delete(tabId);
        if (startedAt !== undefined) {
          const turnDurationMs = Date.now() - startedAt;
          void maybeFireCompletionNotification({
            tabId,
            turnDurationMs,
          });
        }
        break;
      }
      case "error": {
        const message = (data.message as string) ?? "unknown error";
        const tabId = (data.tabId as string | undefined) ?? "default";
        activeResponseIdRef.current = null;
        appendMessage(
          { id: crypto.randomUUID(), role: "agent", text: `Error: ${message}` },
          tabId,
        );
        updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
        if (stateRef.current.activeTabId === tabId) {
          setStatusFlags({ status: "error" });
        }
        break;
      }
      case "notice": {
        // Non-terminal — surface as a system message but DO NOT touch
        // waiting/status. Used e.g. when a second chat IPC arrives while a
        // prompt is in-flight: the user sees the rejection but the Stop
        // button and waiting state for the original prompt persist.
        // Also surface as a warning toast so a notice that arrives
        // while the user isn't looking at chat doesn't get missed.
        const message = (data.message as string) ?? "";
        const tabId = (data.tabId as string | undefined) ?? "default";
        if (message) {
          appendMessage(
            { id: crypto.randomUUID(), role: "system", text: message },
            tabId,
          );
          pushNotification({ title: message, kind: "warning" });
        }
        break;
      }
      case "notification": {
        // Agent-pushed notification. Bridge supplies a stable id (so
        // dismiss can reference it from agent code), title, optional
        // message + kind + actions + durationMs. Auto-expiry runs on
        // the frontend timer; the bridge doesn't track lifecycle.
        const n = (data.notification as Partial<NotificationEntry> | undefined) ?? {};
        if (typeof n.title === "string" && n.title) {
          pushNotification({
            ...(typeof n.id === "string" ? { id: n.id } : {}),
            title: n.title,
            ...(typeof n.message === "string" ? { message: n.message } : {}),
            ...(n.kind ? { kind: n.kind } : {}),
            ...(n.durationMs !== undefined ? { durationMs: n.durationMs } : {}),
            ...(Array.isArray(n.actions) ? { actions: n.actions } : {}),
          });
        }
        ackMutation(data.mutationId, true);
        break;
      }
      case "notification_dismiss": {
        const id = data.id as string | undefined;
        if (id) dismissNotification(id);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_lifecycle": {
        // Generic feedback channel — abstract on purpose so layouts /
        // extensions can decide how (or whether) to surface it.
        //
        // Default behavior in default-layout: dispatch a cancellable
        // `aethon:extension-lifecycle` CustomEvent on window, then (if
        // not preventDefault'd) append a system-notice chat bubble. A
        // custom layout can listen on the event and call
        // `e.preventDefault()` to swap a toast / sidebar pulse / status
        // pill for the default chat-bubble — no source patches required.
        const detail = {
          name: (data.name as string) ?? "(unknown)",
          source: (data.source as string) ?? "directory",
          status: (data.status as "loaded" | "failed" | "skipped") ?? "loaded",
          error: data.error as string | undefined,
          path: data.path as string | undefined,
        };
        const tabId = (data.tabId as string | undefined) ?? "default";
        const ev = new CustomEvent("aethon:extension-lifecycle", {
          detail,
          cancelable: true,
        });
        const proceed = window.dispatchEvent(ev);
        if (proceed) {
          // Default rendering — terse one-liner the user can recognize
          // even when the agent's chat reply was eaten by a respawn.
          const verb =
            detail.status === "loaded"
              ? "loaded"
              : detail.status === "failed"
                ? "failed to load"
                : "skipped";
          const suffix = detail.error ? ` — ${detail.error}` : "";
          appendMessage(
            {
              id: crypto.randomUUID(),
              role: "system",
              text: `Extension \`${detail.name}\` ${verb}${suffix}.`,
            },
            tabId,
          );
        }
        break;
      }
      case "extension_runtime_error": {
        // Sticky, deduped notification per extension. Bridge already
        // rate-limits the underlying log line, so we get one notification
        // when the misbehavior starts (or resumes after the suppression
        // window) — not one every 2s.
        const name = (data.name as string | undefined) ?? "(unknown)";
        const kind = (data.kind as string | undefined) ?? "error";
        const path = (data.path as string | undefined) ?? "";
        const sizeKB = data.sizeKB as number | undefined;
        const limitKB = data.limitKB as number | undefined;
        const message =
          kind === "state-too-large" && sizeKB !== undefined && limitKB !== undefined
            ? `setState ${path} rejected — ${sizeKB} KB exceeds ${limitKB} KB limit. Store file paths, not content.`
            : `Extension reported a runtime error.`;
        pushNotification({
          id: `ext-runtime-error:${name}`,
          title: `Extension \`${name}\` is misbehaving`,
          message,
          kind: "warning",
          durationMs: null,
        });
        break;
      }
      // Legacy single-shot response (kept so old bridge builds still render).
      case "response": {
        const content = (data.content as string) ?? "";
        const tabId = (data.tabId as string | undefined) ?? "default";
        if (content) {
          appendMessage(
            { id: crypto.randomUUID(), role: "agent", text: content },
            tabId,
          );
        }
        if (data.done) {
          updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
          if (stateRef.current.activeTabId === tabId) setStatusFlags({ status: "ready" });
        }
        break;
      }
      case "a2ui": {
        const payload = data.payload as A2UIPayload | undefined;
        const id = (data.id as string) || crypto.randomUUID();
        const tabId = (data.tabId as string | undefined) ?? "default";
        if (payload) {
          appendMessage({ id, role: "agent", a2ui: payload }, tabId);
        }
        if (data.done) {
          updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
          if (stateRef.current.activeTabId === tabId) setStatusFlags({ status: "ready" });
        }
        break;
      }
      case "terminal_output": {
        const content = (data.content as string) ?? "";
        if (!content) break;
        const tabId = (data.tabId as string | undefined) ?? "default";
        // Append to the originating tab's buffer (cap from the right so
        // older content rotates out first). Three sinks now consume each
        // chunk:
        //   1. Per-tab Tab.terminalBuffer — the React record carrying
        //      the rolling scrollback. Used by tab-switch replay.
        //   2. Layout state at /terminal/buffer/<tabId> — bound by $ref
        //      from any A2UI component that wants the live stream
        //      (logging skills, alternative renderers).
        //   3. window CustomEvents — `aethon:terminal` (active tab only,
        //      drives xterm) and `aethon:terminal-tap` (every chunk
        //      regardless of active tab, for multi-subscriber listeners
        //      that need the full stream).
        updateTab(tabId, (tab) => {
          const next = (tab.terminalBuffer ?? "") + content;
          const trimmed = next.length > TERMINAL_REPLAY_MAX
            ? next.slice(next.length - TERMINAL_REPLAY_MAX)
            : next;
          return { ...tab, terminalBuffer: trimmed };
        });
        // Mirror the rolling buffer into shared layout state under
        // /terminal/buffer/<tabId>. A2UI components can $ref it; the
        // bridge sees it via getFrontendState. Path-based so an extension
        // bound to ONE tab doesn't pick up every tab's stream.
        setState((prev) => {
          const term = (prev.terminal as Record<string, unknown> | undefined) ?? {};
          const buffers = (term.buffer as Record<string, string> | undefined) ?? {};
          const next = (buffers[tabId] ?? "") + content;
          const trimmed = next.length > TERMINAL_REPLAY_MAX
            ? next.slice(next.length - TERMINAL_REPLAY_MAX)
            : next;
          return {
            ...prev,
            terminal: {
              ...term,
              buffer: { ...buffers, [tabId]: trimmed },
            },
          };
        });
        if ((stateRef.current.activeTabId as string | undefined) === tabId) {
          window.dispatchEvent(
            new CustomEvent("aethon:terminal", { detail: content }),
          );
        }
        // Tap event always fires (every tab, including background ones)
        // so multi-subscriber listeners can attach without monkey-patching
        // the existing single-subscriber pattern. detail carries tabId so
        // the listener can filter.
        window.dispatchEvent(
          new CustomEvent("aethon:terminal-tap", {
            detail: { tabId, content },
          }),
        );
        break;
      }
    }
  }

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

  // Layout catalogue — built-in entries plus anything an extension or
  // skill has registered via window.aethon.registerLayout. Backed by a
  // ref so the API surface above can mutate it without re-rendering.
  const layoutCatalogueRef = useRef<LayoutCatalogueEntry[]>([...builtinLayouts]);

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
  function summarizeLayoutComponents(payload: A2UIPayload): {
    id: string;
    label: string;
    active: boolean;
  }[] {
    const types = new Set<string>();
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: string; children?: unknown[]; components?: unknown[] };
      if (typeof n.type === "string") types.add(n.type);
      if (Array.isArray(n.children)) n.children.forEach(walk);
      if (Array.isArray(n.components)) n.components.forEach(walk);
    }
    walk(payload);
    return [...types]
      .sort()
      .map((t) => ({ id: `c-${t}`, label: t, active: true }));
  }

  // Refresh /sidebar/components whenever the layout changes so any
  // extension-registered inspector reflects what's actually rendered.
  // setState here is the React → state-derived-from-prop pattern; the
  // lint rule's blanket warning is the "avoid cascading renders"
  // heuristic, and the alternative (computing on each render and
  // injecting at $ref resolve time) would couple the sidebar component
  // to the layout shape — exactly what the JSON-pointer indirection
  // exists to avoid.
  useEffect(() => {
    const list = summarizeLayoutComponents(layout);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      return { ...prev, sidebar: { ...sidebar, components: list } };
    });
  }, [layout]);

  // Layout activation helper — single path used by both
  // window.aethon.activateLayout and the /layout slash command. Seeds
  // the layout's state defaults for keys absent from current app state
  // (live state wins on collisions) and rebuilds /sidebar/layouts from
  // the catalogue + current active id so layout JSONs don't have to
  // ship a hardcoded `active: true` flag.
  function activateLayoutById(id: string): boolean {
    const entry = layoutCatalogueRef.current.find((l) => l.id === id);
    if (!entry) return false;
    setLayout(entry.payload);
    const seeds = entry.payload.state ?? {};
    const catalogueItems = layoutCatalogueRef.current.map((l) => ({
      id: l.id,
      label: l.id,
      active: l.id === id,
    }));
    setState((prev) => {
      const seeded =
        seeds && Object.keys(seeds).length > 0
          ? deepMergeState(seeds, prev)
          : { ...prev };
      // The new layout's `columns` seed is authoritative — different
      // layouts may have different grid SHAPES, and deepMergeState keeps
      // prev's columns, which would mean a 2-col grid carrying a
      // 3-col-only cell has nowhere to render. So force-take the seed's
      // columns, then patch the leading sidebar token with the user's
      // persisted width so cross-layout resizing feels continuous.
      const seedLayout =
        (seeds.layout as Record<string, unknown> | undefined) ?? {};
      const prevLayout =
        (prev.layout as Record<string, unknown> | undefined) ?? {};
      const seedCols = (seedLayout.columns as string | undefined) ?? "";
      const prevCols = (prevLayout.columns as string | undefined) ?? "";
      let nextCols = seedCols;
      if (seedCols && prevCols) {
        const seedTokens = seedCols.trim().split(/\s+/);
        const prevTokens = prevCols.trim().split(/\s+/);
        if (seedTokens.length > 0 && prevTokens[0]?.endsWith("px")) {
          seedTokens[0] = prevTokens[0];
          nextCols = seedTokens.join(" ");
        }
      }
      const seededLayout = (seeded.layout as Record<string, unknown> | undefined) ?? {};
      seeded.layout = nextCols
        ? { ...seededLayout, columns: nextCols }
        : seededLayout;
      const sidebar = (seeded.sidebar as Record<string, unknown> | undefined) ?? {};
      seeded.sidebar = { ...sidebar, layouts: catalogueItems };
      return seeded;
    });
    return true;
  }

  // Extension event-route intercepts. When a route matches an outbound
  // event from the renderer, App's onEvent handler returns false so the
  // event bypasses the built-in switch and goes through the standard
  // a2ui_event channel — letting a paired aethon.onEvent handler on the
  // bridge intercept chat submits / sidebar clicks / etc. without a
  // React-side fork. Wildcard form: { eventType: "submit" } intercepts
  // submits from any component; { componentId: "sidebar" } intercepts
  // every sidebar event.
  const extensionEventRoutesRef = useRef<
    { componentId?: string; eventType?: string }[]
  >([]);
  const extensionEventRoutingModeRef = useRef<"builtin" | "extension">("builtin");

  // Extension keybindings keyed by canonical combo ("meta+shift+p"). Read
  // by the keydown handler; written by hydrateKeybindings on
  // `extension_keybindings` deltas. The keydown handler checks this map
  // before built-ins so extensions can intentionally override default
  // chrome actions.
  const extensionKeybindingsRef = useRef<
    Map<string, { combo: string; action: string; description?: string }>
  >(new Map());
  // name → code for extension-package modules whose `aethon.frontendEntry`
  // JS bodies have been evaluated and registered in the SkillRegistry.
  // Tracked so:
  //   - dropped modules (name absent from a fresh delta) get unregistered
  //   - identical re-deliveries (same name + same code) skip re-eval,
  //     so the duplicate `ready` the bridge fires after the startup
  //     `report` doesn't run top-level side effects twice
  const frontendModulesRef = useRef<Map<string, string>>(new Map());

  // Built once — handlers close over App-scope helpers via the ctx passed at
  // dispatch time, so the registry itself doesn't need state in scope.
  const slashCommandsRef = useRef<SlashCommand[]>(buildBuiltinSlashCommands());
  // Set of names registered via extension delta. Used to reset to
  // built-ins when an `extension_slash_commands` event arrives with a
  // smaller list (extension uninstall / hot-reload drop). Without this
  // we'd never garbage-collect names removed from the bridge's map.
  const extensionSlashNamesRef = useRef<Set<string>>(new Set());
  // Set of JSON Pointer paths the bridge tracked as extension-owned in
  // the LAST `ready` snapshot. On the next `ready`, we delete these from
  // the live state before merging the new tree — so a deleted extension's
  // sidebar section / canvas card / state slice goes away instead of
  // lingering as a frozen artifact. The bridge's NEW snapshot replaces
  // this ref after the merge, so the next ready prunes whatever's stale
  // by then. Boots empty (no prior ready means no stale keys yet).
  const lastExtensionStateKeysRef = useRef<Set<string>>(new Set());

  // Surface the slash command list into layout state so the chat-input
  // autocomplete can resolve it via `$ref:/slashCommands`. Done once on
  // mount; subsequent updates flow through hydrateSlashCommands when
  // extensions register / unregister commands via the bridge.
  useEffect(() => {
    setState((prev) => {
      // Seed /sidebar/layouts from the live catalogue so the appearance
      // pulldown + sidebar layout section both reflect the current
      // active layout, regardless of what the boot JSON happened to
      // ship. activateLayoutById keeps this in sync afterwards.
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const activeLayoutId = (() => {
        const list = (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ?? [];
        return list.find((l) => l.active)?.id ?? layoutCatalogueRef.current[0]?.id;
      })();
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeLayoutId,
      }));
      return {
        ...prev,
        slashCommands: slashCommandsRef.current.map((c) => ({
          name: c.name,
          description: c.description,
          usage: c.usage,
          argSource: c.argSource,
        })),
        // Surface the layout catalogue so the slash-arg picker can resolve
        // /layoutCatalogue when the user types `/layout `. Kept in sync
        // with layoutCatalogueRef in registerLayout / activateLayout.
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
  }, []);

  // Hydrate the extension event-route intercepts. The list is wholesale
  // — every delta from the bridge replaces the prior set. Stored in a
  // ref since the matching loop in onEvent reads it on every event.
  function hydrateEventRoutes(
    routes: { componentId?: string; eventType?: string }[],
    mode: "builtin" | "extension" = extensionEventRoutingModeRef.current,
  ) {
    extensionEventRoutesRef.current = routes;
    extensionEventRoutingModeRef.current = mode;
  }

  // Hydrate the extension-registered keybindings map from a bridge
  // delta (or replayed `ready`). Combos arrive in any human-readable
  // form ("Cmd+Shift+P", "ctrl+]") and are normalized for keydown
  // matching via canonicalCombo / normalizeRegisteredCombo.
  function hydrateKeybindings(
    list: { combo: string; action: string; description?: string }[],
  ) {
    const next = new Map<string, { combo: string; action: string; description?: string }>();
    for (const b of list) {
      const canonical = normalizeRegisteredCombo(b.combo);
      if (!canonical) continue;
      next.set(canonical, { ...b, combo: canonical });
    }
    extensionKeybindingsRef.current = next;
  }

  // Hydrate the extension-registered layout catalogue from a bridge
  // delta (or replayed `ready`). Wholesale replacement: any prior
  // extension-registered entries are dropped, built-ins survive.
  // Mirrors into `state.layoutCatalogue` and `state.sidebar.layouts`
  // so the appearance menu / `/layout` picker / sidebar Layouts
  // section all re-resolve via $ref.
  function hydrateExtensionLayouts(
    list: {
      id: string;
      name: string;
      description?: string;
      payload: A2UIPayload;
    }[],
  ) {
    const builtinIds = new Set(builtinLayouts.map((l) => l.id));
    const surviving = layoutCatalogueRef.current.filter((l) => builtinIds.has(l.id));
    const incoming = list
      .filter((l) => !builtinIds.has(l.id) && typeof l.id === "string" && l.payload)
      .map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        payload: l.payload,
      }));
    layoutCatalogueRef.current = [...surviving, ...incoming];
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const prevLayoutItems =
        (sidebar.layouts as { id: string; active?: boolean }[] | undefined) ?? [];
      const activeId =
        prevLayoutItems.find((l) => l.active)?.id ??
        layoutCatalogueRef.current[0]?.id;
      const catalogueItems = layoutCatalogueRef.current.map((l) => ({
        id: l.id,
        label: l.id,
        active: l.id === activeId,
      }));
      return {
        ...prev,
        layoutCatalogue: layoutCatalogueRef.current.map((l) => ({
          id: l.id,
          label: l.name,
          description: l.description,
        })),
        sidebar: { ...sidebar, layouts: catalogueItems },
      };
    });
  }

  // Skill packages with `aethon.frontendEntry` ship a JS body to the
  // webview where it's wrapped with `new Function("React", "skill",
  // code)` and executed. The module API hooks the result into the
  // SkillRegistry so the registered React components show up under
  // their declared A2UI types in any layout. Wholesale replacement on
  // each delta — components from a removed module go away, a re-eval'd
  // module replaces its prior bindings (so a hot reload picks up new
  // code). Errors per module are caught and surfaced as a `notice` so
  // one broken module doesn't kill the others.
  function hydrateFrontendModules(list: { name: string; code: string }[]) {
    const previous = frontendModulesRef.current;
    const { loaded, unregistered } = reconcileFrontendModules(
      previous,
      list,
      registry,
    );
    frontendModulesRef.current = new Map(list.map((m) => [m.name, m.code]));
    for (const m of loaded) {
      if (m.error) {
        appendSystem(`extension frontend module ${m.name}: ${m.error}`);
      }
    }
    if (loaded.length > 0 || unregistered.length > 0) {
      // Bump a counter so any A2UIRenderer subtree using a now-changed
      // component type re-resolves through the SkillRegistry on the
      // next render. The registry itself doesn't trigger React updates;
      // bumping a piece of state owned by App.tsx does. Skipped (no-op)
      // modules don't need a bump — their components are unchanged.
      setState((prev) => ({
        ...prev,
        extensionModulesGen: ((prev.extensionModulesGen as number | undefined) ?? 0) + 1,
      }));
    }
  }

  // Merge extension-registered slash commands with the built-ins.
  // Extension commands dispatch through the existing onEvent pipeline
  // as {componentType: "slash-command", componentId: "slash-command__tpl__<name>",
  // data: {args}} so a paired bridge-side aethon.onEvent matcher fires
  // the handler with no bespoke dispatch path.
  function hydrateSlashCommands(
    list: { name: string; description: string; usage?: string }[],
  ) {
    const builtins = buildBuiltinSlashCommands();
    const builtinNames = new Set(builtins.map((c) => c.name));
    const dispatched: SlashCommand[] = list
      .filter((c) => !builtinNames.has(c.name)) // bridge already rejects collisions; defense-in-depth
      .map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        run: async (args: string) => {
          // Wrap the agent dispatch so the chat-side path stays uniform.
          // No local state mutation — the handler may call setState/
          // pi.prompt/etc through the bridge's ctx.
          await invoke("dispatch_a2ui_event", {
            event: JSON.stringify({
              componentId: `slash-command__tpl__${c.name}`,
              componentType: "slash-command",
              templateRootType: "slash-command",
              eventType: "invoke",
              data: { args },
            }),
            tabId: stateRef.current.activeTabId,
          });
        },
      }));
    extensionSlashNamesRef.current = new Set(dispatched.map((c) => c.name));
    slashCommandsRef.current = [...builtins, ...dispatched];
    // Refresh the layout's bound /slashCommands so the picker re-resolves.
    setState((prev) => ({
      ...prev,
      slashCommands: slashCommandsRef.current.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        argSource: c.argSource,
      })),
    }));
  }

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

  // Intercept events from layout-level components before they reach the agent.
  // The layout speaks A2UI, but a few interactions need to drive native APIs
  // (Tauri IPC for chat send, model picker) — this is where the renderer
  // hands off control.
  const onEvent = useMemo(
    () => async (component: { id: string; type?: string }, eventType: string, data?: unknown) => {
      // Reserved system notifications: shell-write consent prompts
      // (M6 P2.2) MUST run before extension-route interception so a
      // user-driven Allow/Deny / dismiss can never be hijacked by an
      // extension. Same-name event matches on `notification-stack`
      // would otherwise route to the bridge and the user's click
      // becomes a silent no-op while `aethon.shells.write` waits for
      // its 5-min timeout. Filter narrowly: only events whose action
      // string starts with the reserved `shell-write-` prefix, plus
      // `dismiss`/`expire` of an id that has a pending resolver. Any
      // other notification-stack event still flows through routing.
      if (component.id === "notification-stack") {
        const id = (data as { id?: string } | undefined)?.id;
        const action = (data as { action?: string } | undefined)?.action;
        const isShellWriteAction =
          eventType === "action" &&
          typeof action === "string" &&
          action.startsWith("shell-write-");
        const isShellWriteDismiss =
          (eventType === "dismiss" || eventType === "expire") &&
          typeof id === "string" &&
          hasPendingShellWriteConsent(id);
        if (isShellWriteAction && id && action) {
          const allowed = action.startsWith("shell-write-allow:");
          resolveShellWriteConsent(id, allowed);
          dismissNotification(id);
          return true;
        }
        if (isShellWriteDismiss && id) {
          resolveShellWriteConsent(id, false);
          dismissNotification(id);
          return true;
        }
        // Close-shell-tab consent prompts. Same security shape as
        // shell-write — must run before extension-route interception
        // so a user's Close / Cancel can't be hijacked. Filter
        // narrowly on the reserved `shell-close-` prefix + a dismiss
        // of an id with a pending resolver.
        const isShellCloseAction =
          eventType === "action" &&
          typeof action === "string" &&
          action.startsWith("shell-close-");
        const isShellCloseDismiss =
          (eventType === "dismiss" || eventType === "expire") &&
          typeof id === "string" &&
          hasPendingShellCloseConsent(id);
        if (isShellCloseAction && id && action) {
          const allowed = action.startsWith("shell-close-allow:");
          resolveShellCloseConsent(id, allowed);
          dismissNotification(id);
          return true;
        }
        if (isShellCloseDismiss && id) {
          resolveShellCloseConsent(id, false);
          dismissNotification(id);
          return true;
        }
        // Session-delete consent prompts. Same security shape as the
        // shell-close path — narrowly filtered on the reserved
        // `session-delete-` prefix + a dismiss of an id with a pending
        // resolver. Must run before extension-route interception so a
        // user's Delete / Cancel can't be hijacked by a registered
        // notification handler.
        const isSessionDeleteAction =
          eventType === "action" &&
          typeof action === "string" &&
          action.startsWith("session-delete-");
        const isSessionDeleteDismiss =
          (eventType === "dismiss" || eventType === "expire") &&
          typeof id === "string" &&
          hasPendingSessionDeleteConsent(id);
        if (isSessionDeleteAction && id && action) {
          const allowed = action.startsWith("session-delete-allow:");
          resolveSessionDeleteConsent(id, allowed);
          dismissNotification(id);
          return true;
        }
        if (isSessionDeleteDismiss && id) {
          resolveSessionDeleteConsent(id, false);
          dismissNotification(id);
          return true;
        }
        // P5: agent-crashed notification actions. Restart respawns
        // the bridge; dismiss just closes the toast.
        if (
          eventType === "action" &&
          typeof action === "string" &&
          action.startsWith("ae-agent-crashed:")
        ) {
          if (action === "ae-agent-crashed:restart") {
            invoke("start_agent").catch((err: unknown) => {
              console.warn("agent restart failed:", err);
            });
          }
          if (id) dismissNotification(id);
          return true;
        }
        // Hang-warn notification actions.
        if (
          eventType === "action" &&
          typeof action === "string" &&
          action.startsWith("hang-warn:")
        ) {
          if (action.startsWith("hang-warn:stop")) {
            // Stop carries the tabId of the hung tab (set when the
            // notification was pushed) so the right session is stopped
            // even if the user is on a different tab when they click.
            const targetTabId = action.startsWith("hang-warn:stop:")
              ? action.slice("hang-warn:stop:".length)
              : undefined;
            void stopPrompt(targetTabId);
          } else if (action === "hang-warn:force-restart") {
            // force_restart_agent SIGKILLs the bun child from Rust, bypassing
            // blocked stdin. The existing agent-crashed handler then fires,
            // clearing waiting state and (if auto_restart_agent) respawning.
            invoke("force_restart_agent").catch((err: unknown) => {
              console.warn("force_restart_agent failed:", err);
            });
          }
          if (id) dismissNotification(id);
          return true;
        }
      }
      // Extensions can register event-route intercepts via
      // aethon.registerEventRoute. When an event matches a registered
      // route, we return false here so the renderer falls through to
      // the default dispatch (a2ui_event → bridge), letting the
      // extension's aethon.onEvent({componentType, descendantId})
      // handler run instead of the built-in switch below. Wildcards:
      // a route with only `componentId` matches any eventType for
      // that component; only `eventType` matches every component.
      if (extensionEventRoutingModeRef.current === "extension") {
        return false;
      }
      const routes = extensionEventRoutesRef.current;
      if (routes.length > 0) {
        const matched = routes.some((r) => {
          const cidOk = !r.componentId || r.componentId === component.id;
          const evtOk = !r.eventType || r.eventType === eventType;
          return cidOk && evtOk;
        });
        if (matched) {
          // Suppress optimistic UI: the renderer always applies an
          // optimistic update for change/submit on $ref-bound inputs
          // before this callback runs, but for an intercepted submit
          // we still want the bridge to get the event so a paired
          // handler on the bridge can decide what to do (e.g. preprocess
          // the prompt before sendChat).
          // Returning false lets the renderer's invoke('dispatch_a2ui_event')
          // fire normally. `data` (which carries `value` for submits)
          // rides along intact.
          // Suppress sendChat side effect for chat-input submits — the
          // bridge handler is now the source of truth for that event.
          // For other intercepted events (sidebar select, tab close)
          // returning false here is sufficient.
          // (We don't filter by component.id; the test above did that.)
          return false;
        }
      }
      // Settings panel events (M6 P3). Renders at App root like the
      // palette. Update applies a partial AethonConfig to the pending
      // overlay; save commits via write_config; close discards.
      if (component.id === "settings-panel") {
        if (eventType === "close") {
          closeSettings();
          return true;
        }
        if (eventType === "update") {
          const patch = (data as { patch?: Record<string, unknown> } | undefined)?.patch;
          if (patch) applySettingsPatch(patch);
          return true;
        }
        if (eventType === "save") {
          void saveSettings();
          return true;
        }
      }

      // Cross-session search panel events (M6 P6). Like the palette,
      // renders at App root and never goes through the bridge —
      // search results land via the Tauri search_sessions command.
      if (component.id === "search-panel") {
        if (eventType === "close") {
          closeSessionSearch();
          return true;
        }
        if (eventType === "query") {
          const value = (data as { value?: string } | undefined)?.value ?? "";
          setSearchQuery(value);
          return true;
        }
        if (eventType === "scope") {
          const scope = (data as { scope?: "all" | "current" } | undefined)
            ?.scope;
          if (scope === "all" || scope === "current") {
            setSearchScope(scope);
          }
          return true;
        }
        if (eventType === "select") {
          const hit = (data as
            | {
                hit?: {
                  tabId?: string;
                  snippetMatch?: string;
                };
              }
            | undefined)?.hit;
          if (hit) openSearchHit(hit);
          return true;
        }
      }

      // Command palette events. Palette renders at App root; events
      // route here directly (it never goes through the dispatch_a2ui
      // bridge because there's no agent counterpart to invoke).
      if (component.id === "command-palette") {
        if (eventType === "close") {
          closePalette();
          return true;
        }
        if (eventType === "query") {
          const value = (data as { value?: string } | undefined)?.value ?? "";
          setState((prev) => ({
            ...prev,
            palette: { ...(prev.palette ?? {}), query: value, selectedIndex: 0 },
          }));
          return true;
        }
        if (eventType === "navigate") {
          const idx = (data as { index?: number } | undefined)?.index ?? 0;
          setState((prev) => ({
            ...prev,
            palette: { ...(prev.palette ?? {}), selectedIndex: idx },
          }));
          return true;
        }
        if (eventType === "select") {
          const item = (data as { item?: PaletteItem } | undefined)?.item;
          if (item) {
            // Close FIRST so a slow handler doesn't leave the palette
            // open over the result. Then run async.
            closePalette();
            void runPaletteItem(item);
          }
          return true;
        }
      }
      // Notification stack events.
      if (component.id === "notification-stack") {
        const id = (data as { id?: string } | undefined)?.id;
        if ((eventType === "dismiss" || eventType === "expire") && id) {
          // Dismissing a pending shell-write / shell-close / session-delete
          // confirmation = deny. All resolvers fire on every dismiss/expire
          // so a dropped notification can't dangle the originator's promise.
          resolveShellWriteConsent(id, false);
          resolveShellCloseConsent(id, false);
          resolveSessionDeleteConsent(id, false);
          dismissNotification(id);
          return true;
        }
        if (eventType === "action" && id) {
          const action = (data as { action?: string } | undefined)?.action;
          // Built-in shell-write / shell-close / session-delete Allow/Deny
          // actions resolve pending consents without a bridge round-trip.
          // Other actions get forwarded as a2ui events for extension matchers.
          if (action && action.startsWith("shell-write-")) {
            const allowed = action.startsWith("shell-write-allow:");
            resolveShellWriteConsent(id, allowed);
          } else if (action && action.startsWith("shell-close-")) {
            const allowed = action.startsWith("shell-close-allow:");
            resolveShellCloseConsent(id, allowed);
          } else if (action && action.startsWith("session-delete-")) {
            const allowed = action.startsWith("session-delete-allow:");
            resolveSessionDeleteConsent(id, allowed);
          } else if (action) {
            invoke("dispatch_a2ui_event", {
              event: JSON.stringify({
                componentId: `notification__tpl__${id}`,
                componentType: "notification",
                templateRootType: "notification",
                eventType: "invoke",
                data: { id, action },
              }),
              tabId: stateRef.current.activeTabId,
            }).catch(() => {
              /* ignore — bridge gone */
            });
          }
          dismissNotification(id);
          return true;
        }
      }
      if (component.id === "chat-input" && eventType === "submit") {
        const value = (data as { value?: string } | undefined)?.value ?? "";
        await sendChat(value);
        return true;
      }
      if (component.id === "chat-input" && eventType === "change") {
        // The renderer's optimistic update wrote /draft (the active-tab
        // mirror); also write into the active tab record so an unsent
        // draft survives a tab switch and isn't clobbered when the
        // tab is re-mirrored to root on switch-back.
        const value = (data as { value?: string } | undefined)?.value ?? "";
        updateActiveTab((tab) => ({ ...tab, draft: value }));
        return true;
      }
      if (component.id === "chat-input" && eventType === "cancel") {
        await stopPrompt();
        return true;
      }
      // Tab events route by component *type* — id may vary across layouts
      // (workstation hoists the strip into the header as `header-tabs`).
      // Matching by type keeps the contract layout-agnostic so a future
      // layout's tabs work without touching App.tsx.
      const tabType = component.type;

      // Terminal panel sub-tab events (M6 restructure). The panel
      // hosts the read-only agent-bash sub-tab plus every shell as a
      // separate sub-tab; selection / close / new-shell live here.
      if (component.type === "terminal-panel") {
        const sel = data as { subTabId?: string } | undefined;
        if (eventType === "select-sub-tab" && sel?.subTabId) {
          setActiveSubTab(sel.subTabId);
          return true;
        }
        if (eventType === "close-sub-tab" && sel?.subTabId) {
          // Closing a shell sub-tab is just closing its underlying tab.
          // The agent-bash sub-tab can't be closed (no X button rendered).
          if (sel.subTabId !== "agent-bash") {
            closeTab(sel.subTabId);
          }
          return true;
        }
        if (eventType === "new-shell-sub-tab") {
          newShellTab();
          return true;
        }
      }

      // Share-mode cycle. Match either source: the inline badge inside
      // ShellCanvas re-emits on the shell-canvas channel; a standalone
      // `<share-mode-badge>` placed directly in a custom layout emits
      // on its own component type. Either path runs the same effect:
      // look up the current mode, advance via the cycle helper, persist
      // through the Rust side AND mirror locally so the badge label
      // refreshes immediately.
      if (
        eventType === "cycle-share-mode" &&
        (component.type === "shell-canvas" ||
          component.type === "share-mode-badge")
      ) {
        const sel = data as { tabId?: string } | undefined;
        const id = sel?.tabId;
        if (typeof id !== "string" || !id) return true;
        const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
        const tab = tabs.find((t) => t.id === id);
        if (!tab || tab.kind !== "shell" || !tab.shell) return true;
        const next = cycleShareMode(tab.shell.shareMode);
        invoke("shell_set_share_mode", { tabId: id, mode: next })
          .then(() => {
            applyShareModeToTab(id, next);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("shell_set_share_mode failed:", msg);
          });
        return true;
      }

      const isTabSurface = tabType === "tab-strip";
      if (isTabSurface) {
        const sel = data as { tabId?: string; action?: string; id?: string } | undefined;
        if (eventType === "select" && sel?.tabId) {
          setActiveTab(sel.tabId);
          return true;
        }
        if (eventType === "close" && sel?.tabId) {
          closeTab(sel.tabId);
          return true;
        }
        if (eventType === "new") {
          newTab();
          return true;
        }
      }
      if (component.id === "empty-state") {
        if (eventType === "new-tab") {
          newTab();
          return true;
        }
        if (eventType === "open-project") {
          // Pop the native folder picker. On a successful pick we've
          // already persisted + announced the new project — open a
          // fresh tab in it so the user lands ready-to-chat. If they
          // cancel, leave the empty state visible.
          openProjectFromPicker().then((id) => {
            if (id) newTab();
          });
          return true;
        }
        if (eventType === "select-project") {
          const sel = data as
            | { projectId?: string; label?: string; path?: string }
            | undefined;
          if (sel?.projectId) {
            setActiveProjectById(sel.projectId);
            // Only seed a fresh tab when the project's bucket is empty.
            // If the user already has tabs in this project, the bucket
            // load above restored them — popping a new tab on top would
            // be jarring.
            const tabsAfter =
              (stateRef.current.tabs as Tab[] | undefined) ?? [];
            if (tabsAfter.length === 0) newTab();
          }
          return true;
        }
        if (eventType === "restore-session") {
          const sel = data as
            | { sessionId?: string; label?: string; cwd?: string }
            | undefined;
          if (sel?.sessionId) {
            // Re-open the persisted session by reusing the same tabId.
            // The bridge's SessionManager.continueRecent reads the
            // existing JSONL files so the LLM history is restored too.
            newTab(sel.sessionId, sel.label ?? "Restored Session", {
              restoredSession: true,
              ...(sel.cwd ? { cwd: sel.cwd } : {}),
            });
          } else {
            newTab();
          }
          return true;
        }
      }
      if (component.id === "sidebar" && eventType === "resize") {
        const next = (data as { width?: number } | undefined)?.width;
        if (typeof next === "number") {
          // Patch the leading width token in /layout/columns. Layouts
          // shape their grid columns as either "${SIDEBAR}px minmax(0,1fr)"
          // or "${SIDEBAR}px minmax(0,1fr) ${INSPECTOR}px" — replace just the first
          // token so non-sidebar columns survive the rewrite.
          setState((prev) => {
            const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
            const current =
              (layout.columns as string | undefined) ?? "220px minmax(0,1fr)";
            const tokens = current.trim().split(/\s+/);
            tokens[0] = `${next}px`;
            return { ...prev, layout: { ...layout, columns: tokens.join(" ") } };
          });
        }
        return true;
      }
      if (component.id === "sidebar" && eventType === "resize-end") {
        // Persist the final width so the next boot opens at the same
        // size. Read from state.layout.columns (the in-flight value the
        // resize listener just wrote) so a single source of truth wins.
        const layout = (stateRef.current.layout as Record<string, unknown> | undefined) ?? {};
        const cols = (layout.columns as string | undefined) ?? "";
        const lead = cols.trim().split(/\s+/)[0] ?? "";
        const px = parseInt(lead, 10);
        if (Number.isFinite(px) && px > 0) {
          writeState("sidebar_width", String(px)).catch(() => {
            /* ignore — best-effort */
          });
        }
        return true;
      }
      if (component.id === "sidebar" && eventType === "remove-project") {
        const selected = data as
          | { projectId?: string; itemId?: string }
          | undefined;
        const projectId = selected?.projectId ?? selected?.itemId;
        return projectId ? removeProjectById(projectId) : true;
      }
      if (component.id === "sidebar" && eventType === "delete-session") {
        const selected = data as
          | { sessionId?: string; itemId?: string; label?: string }
          | undefined;
        // Strip the "session:" or "tab:" prefix defensively in case a
        // future caller forgets the split — the sidebar already strips
        // it but we don't want a stray prefix to land in the Tauri
        // command path validator.
        const raw = selected?.sessionId ?? selected?.itemId ?? "";
        const sessionId = extractSessionId(raw);
        const label = selected?.label ?? sessionId;
        if (!sessionId) return true;
        promptDeleteSessionConfirmation(label).then((allowed) => {
          if (!allowed) return;
          const isOpen = (stateRef.current.tabs as Tab[] | undefined)?.some(
            (t) => t.id === sessionId,
          );
          // Delete first, then close. Doing the reverse leaves the user
          // with a closed tab and a failure notification when the Tauri
          // command refuses (e.g. the default session). codex P2 review
          // feedback.
          invoke("delete_session", { tabId: sessionId })
            .then(() => {
              if (isOpen) closeTab(sessionId);
              allDiscoveredSessionsRef.current =
                allDiscoveredSessionsRef.current.filter(
                  (s) => s.tabId !== sessionId,
                );
              syncRecentSessionsToState();
              pushNotification({
                title: "Session deleted",
                message: label,
                kind: "success",
              });
            })
            .catch((err: unknown) => {
              pushNotification({
                title: "Delete session failed",
                message: String(err),
                kind: "error",
              });
            });
        });
        return true;
      }
      // Sidebar select + dropdown chrome pickers (model-picker /
      // appearance-menu) all use the same `{sectionId, itemId}` event
      // shape. Route by section so a chrome dropdown and a sidebar row
      // converge on the same backing action.
      const isSectionedSelect =
        eventType === "select" &&
        (component.id === "sidebar" ||
          component.id === "model-picker" ||
          component.id === "appearance-menu");
      if (isSectionedSelect) {
        const selected = data as { sectionId?: string; itemId?: string } | undefined;
        if (selected?.itemId === "toggle-terminal") {
          toggleTerminal();
          return true;
        }
        if (selected?.itemId === "clear-chat") {
          clearChat();
          return true;
        }
        if (selected?.sectionId === "models" && selected.itemId) {
          await setModel(selected.itemId);
          return true;
        }
        if (selected?.sectionId === "themes" && selected.itemId) {
          // Accept any registered theme id (built-ins + extension themes).
          // The CSS for built-ins lives in styles.css; extension themes
          // had their <style> tag injected on hydrateThemes().
          setTheme(selected.itemId);
          return true;
        }
        if (selected?.sectionId === "layouts" && selected.itemId) {
          activateLayoutById(selected.itemId);
          return true;
        }
        if (selected?.sectionId === "projects" && selected.itemId) {
          // The sidebar's projects section also surfaces an "Open
          // project…" action item; intercept it here so we don't try
          // to look it up as a project id.
          if (selected.itemId === "open-project") {
            openProjectFromPicker();
            return true;
          }
          setActiveProjectById(selected.itemId);
          return true;
        }
        if (selected?.sectionId === "history" && selected.itemId) {
          if (selected.itemId.startsWith("tab:")) {
            setActiveTab(selected.itemId.slice(4));
            return true;
          }
          if (selected.itemId.startsWith("session:")) {
            const sessionId = selected.itemId.slice(8);
            const recentSessions =
              (stateRef.current.recentSessions as RecentSessionItem[] | undefined) ?? [];
            const item = recentSessions.find((s) => s.id === sessionId);
            newTab(sessionId, item?.label ?? `Session ${sessionId.slice(0, 8)}`, {
              restoredSession: true,
              ...(item?.cwd ? { cwd: item.cwd } : {}),
            });
            return true;
          }
          return true;
        }
      }
      return false;
    },
    // The closures inside this onEvent dispatch (newTab, closeTab,
    // sendChat, etc.) read live state via stateRef / setState callbacks.
    // Adding them as deps would force the memo to re-build every render
    // — losing any consumer-side memoization keyed on its identity —
    // without changing observed behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
