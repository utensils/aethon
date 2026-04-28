import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import A2UIRenderer from "./components/A2UIRenderer";
import { SkillRegistry } from "./skills/SkillRegistry";
import { SkillRegistryProvider } from "./skills/registry";
import {
  builtinLayouts,
  defaultLayoutSkill,
  inspectLayoutSlotCoverage,
  layoutSlots,
} from "./skills/default-layout";
import { CommandPalette } from "./skills/default-layout/command-palette";
import type {
  PaletteItem,
  PaletteMode,
} from "./skills/default-layout/palette-items";
import { NotificationStack } from "./skills/default-layout/notifications";
import type {
  NotificationEntry,
  NotificationKind,
} from "./skills/default-layout/notifications";
import type { LayoutCatalogueEntry, SlotCoverageReport } from "./skills/default-layout";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import type { A2UISkill } from "./skills/types";
import { deletePointer, setPointer } from "./utils/jsonPointer";
// Vite resolves `?url` imports to a hashed asset URL at build time. Injecting
// the URL into layout state lets the header bind via `{"$ref": "/logoUrl"}`
// instead of hardcoding a path that might 404 in a production bundle.
import logoUrl from "./assets/aethon-logo.svg?url";

// Immutable JSON Pointer write that preserves arrays. The generic
// setPointer in utils/jsonPointer turns `{...arr}` into a plain object,
// which breaks the renderer when a layout's `components`/`children`
// arrays get traversed. This walker spreads with `[...arr]` for arrays
// so the layout shape is preserved end-to-end.
function decodeToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}
function layoutPatch<T>(payload: T, pointer: string, value: unknown): T {
  if (!pointer || pointer === "" || pointer === "/") return payload;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodeToken);
  const cloneNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === "object") return { ...(node as Record<string, unknown>) };
    return {};
  };
  const root = cloneNode(payload) as Record<string, unknown> | unknown[];
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const idx = Array.isArray(cursor) ? Number(key) : key;
    const existing = (cursor as Record<string | number, unknown>)[idx as never];
    const child = cloneNode(existing);
    (cursor as Record<string | number, unknown>)[idx as never] = child;
    cursor = child as Record<string, unknown> | unknown[];
  }
  const lastKey = tokens[tokens.length - 1];
  const lastIdx = Array.isArray(cursor) ? Number(lastKey) : lastKey;
  (cursor as Record<string | number, unknown>)[lastIdx as never] = value;
  return root as T;
}

// Recursive structural merge. Plain objects recurse; arrays and primitives
// replace. Used when folding the bridge's extension state snapshot into
// app state so an extension's nested key doesn't wipe siblings.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
function deepMergeState(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMergeState(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
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
import { getConfig } from "./config";
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

// The default-layout skill ships a layout — that's the boot payload.
const BOOT_LAYOUT: A2UIPayload = defaultLayoutSkill.layout!;

const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;

function writeUiViewportVars(scale: number) {
  const root = document.documentElement;
  root.style.setProperty("--app-viewport-width", `${window.innerWidth / scale}px`);
  root.style.setProperty("--app-viewport-height", `${window.innerHeight / scale}px`);
}

function applyUiScale(scale: number) {
  const root = document.documentElement;
  root.style.setProperty("--app-ui-scale", String(scale));
  writeUiViewportVars(scale);
  root.style.zoom = String(scale);
}

function readZoom(): number {
  const cur = parseFloat(
    document.documentElement.style.getPropertyValue("--app-ui-scale") ||
      document.documentElement.style.zoom ||
      "1",
  );
  return Number.isFinite(cur) ? cur : 1;
}

interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
}

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
}

interface SidebarHistoryItem {
  id: string;
  label: string;
  hint?: string;
  tooltip?: string;
  active?: boolean;
}

// Format a millisecond timestamp into a compact relative-time label like
// "2m ago" / "3h ago" / "yesterday" / "Apr 22". Used by the empty-state's
// recent-sessions list — full timestamps are too noisy and "12345678 ms"
// is meaningless to a user.
function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Normalize a keyboard event to the same canonical combo string the bridge
// stores (lowercased, sorted modifiers, "+"-joined). Returns null when no
// printable key was involved (modifier keys alone don't match a combo).
//
//   Cmd+Shift+P   →  "meta+shift+p"
//   Ctrl+]        →  "ctrl+]"
//   Alt+M         →  "alt+m"
function canonicalCombo(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || k.length === 0) return null;
  // Skip modifier-only events (pressing just Shift/Cmd/etc.)
  if (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt") return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(k.toLowerCase());
  return parts.join("+");
}

// Bridge accepts a wide variety of human-readable combo formats
// ("Cmd+Shift+P", "ctrl+]", "Meta+M") and we normalize on the frontend
// for matching. Keep the modifier order stable so equivalent combos
// hash to the same canonical form.
function normalizeRegisteredCombo(combo: string): string {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  // Aliases: cmd → meta, command → meta, control → ctrl, option → alt.
  const aliased = parts.map((p) =>
    p === "cmd" || p === "command"
      ? "meta"
      : p === "control"
        ? "ctrl"
        : p === "option"
          ? "alt"
          : p,
  );
  const mods = new Set<string>();
  let key = "";
  for (const p of aliased) {
    if (p === "meta" || p === "ctrl" || p === "alt" || p === "shift") {
      mods.add(p);
    } else {
      key = p;
    }
  }
  // Stable ordering matches canonicalCombo above (meta/ctrl/alt/shift).
  const ordered = ["meta", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
  return [...ordered, key].filter(Boolean).join("+");
}

// Replace `image` component data URLs with a placeholder so persisted history
// doesn't blow past the localStorage quota. The in-memory message keeps the
// full data URL — only the persisted copy is slimmed.
function stripImageDataUrls(component: unknown): unknown {
  if (!component || typeof component !== "object") return component;
  const c = component as {
    type?: string;
    props?: Record<string, unknown>;
    children?: unknown[];
  };
  let next = c;
  if (
    c.type === "image" &&
    typeof c.props?.src === "string" &&
    c.props.src.startsWith("data:")
  ) {
    next = { ...c, props: { ...c.props, src: "", caption: "[image dropped from history]" } };
  }
  if (Array.isArray(c.children) && c.children.length > 0) {
    next = { ...next, children: c.children.map(stripImageDataUrls) };
  }
  return next;
}

const MAX_TEXT_BYTES = 8 * 1024;

function trimMessage(m: ChatMessage): ChatMessage {
  let out = m;
  if (m.text && m.text.length > MAX_TEXT_BYTES) {
    out = { ...out, text: m.text.slice(0, MAX_TEXT_BYTES - 1) + "…" };
  }
  if (m.a2ui && Array.isArray(m.a2ui.components)) {
    out = {
      ...out,
      a2ui: { ...m.a2ui, components: m.a2ui.components.map(stripImageDataUrls) as never },
    };
  }
  return out;
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
  // also write the root mirror.
  // ---------------------------------------------------------------------
  interface Tab {
    id: string;
    label: string;
    messages: ChatMessage[];
    draft: string;
    waiting: boolean;
    queueCount: number;
    canvas: unknown;
    model: string;
    // Rolling buffer of bash output for this tab. The Terminal component
    // writes to xterm directly for the active tab; this buffer survives
    // tab switches so the panel can replay it when the user comes back.
    // Capped client-side too (TERMINAL_REPLAY_MAX) to bound memory.
    terminalBuffer: string;
    // Project this tab belongs to. `null` means the no-project bucket
    // (tabs created before any project was picked, or after
    // clearActiveProject). Tabs are isolated per project — switching
    // projects swaps `state.tabs` for the target project's bucket and
    // hides everyone else.
    projectId: string | null;
  }
  // Sentinel key for the "no project" bucket. Project ids are UUIDs so
  // a literal can't collide.
  const NO_PROJECT_KEY = "__no_project__";
  const projectBucketKey = (id: string | null | undefined) =>
    id ?? NO_PROJECT_KEY;
  function makeEmptyTab(
    id: string,
    label: string,
    projectId: string | null = null,
  ): Tab {
    return {
      id,
      label,
      messages: [],
      draft: "",
      waiting: false,
      queueCount: 0,
      canvas: null,
      model: "",
      terminalBuffer: "",
      projectId,
    };
  }
  const buildSidebarHistory = useCallback((
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: RecentSessionItem[],
  ): SidebarHistoryItem[] => {
    const openIds = new Set(tabs.map((t) => t.id));
    const previewText = (messages: ChatMessage[]) => {
      const last = [...messages]
        .reverse()
        .find((m) => typeof m.text === "string" && m.text.trim().length > 0);
      return last?.text?.replace(/\s+/g, " ").trim() ?? "";
    };
    const openHistory = tabs
      .filter((t) => t.messages.length > 0)
      .map((t) => {
        const preview = previewText(t.messages);
        return {
          id: `tab:${t.id}`,
          label: t.label,
          hint: t.id === activeTabId ? "active" : `${t.messages.length} msg`,
          tooltip: preview || t.label,
          active: t.id === activeTabId,
        };
      });
    const restoredHistory = recentSessions
      .filter((s) => !openIds.has(s.id))
      .map((s) => ({
        id: `session:${s.id}`,
        label: s.label,
        hint: s.lastModified,
        tooltip: "Restore session",
      }));
    return [...openHistory, ...restoredHistory].slice(0, 16);
  }, []);
  // Per-tab terminal buffer cap. Bash output bursts can be huge; without
  // a ceiling the buffer would grow forever and slow tab switches as the
  // replay payload grows.
  const TERMINAL_REPLAY_MAX = 256 * 1024;

  // The layout's state IS the app state. Single source of truth, addressed by
  // JSON Pointer from the layout payload. We seed `logoUrl` here so the header
  // can $ref it without the layout JSON having to know the hashed asset path.
  // Initial state also seeds one default tab + the active-tab mirror keys.
  const [state, setState] = useState<Record<string, unknown>>(() => {
    const tab0 = makeEmptyTab("default", "Tab 1");
    return {
      ...(BOOT_LAYOUT.state ?? {}),
      logoUrl,
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
  // Per app session, remember persisted sessions we auto-opened from
  // `[ui] restore_tabs = true` so repeated ready/report events don't
  // duplicate tabs.
  const autoRestoredSessionIdsRef = useRef(new Set<string>());

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
  // UI zoom — Cmd+/- / Cmd+0 to scale the entire chrome the way browsers
  // and editors do. CSS zoom scales text + spacing together, while the
  // --app-ui-scale token lets viewport-bound shells and portals divide
  // their dimensions back down. Without that compensation, 100vw/100vh
  // elements become wider/taller than the visible window at >100%.
  // ---------------------------------------------------------------------
  function applyZoom(next: number) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const rounded = Math.round(clamped * 100) / 100;
    applyUiScale(rounded);
    writeState("ui_zoom", String(rounded)).catch(() => {
      /* best-effort */
    });
    pushNotification({
      id: "ae-zoom",
      title: `Zoom ${Math.round(rounded * 100)}%`,
      kind: "info",
      durationMs: 1200,
    });
  }
  function adjustZoom(delta: number) {
    applyZoom(readZoom() + delta);
  }
  function resetZoom() {
    applyZoom(1);
  }

  useEffect(() => {
    const onResize = () => writeUiViewportVars(readZoom());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function setTheme(id: string) {
    document.documentElement.dataset.theme = id;
    writeState("theme", id).catch(() => {
      /* ignore */
    });
    // Update /sidebar/themes' active flag so the appearance pulldown +
    // sidebar themes section both reflect the new selection without a
    // separate hydrate pass.
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const themes = ((sidebar.themes as { id: string; label: string }[] | undefined) ?? [])
        .map((t) => ({ ...t, active: t.id === id }));
      return { ...prev, sidebar: { ...sidebar, themes } };
    });
  }

  // Persistent chat history — restore on mount, write debounced on change.
  // Cap at 200 messages and 8KB per text field. Storage is `~/.aethon/messages.json`
  // via Tauri commands; the previous localStorage key is migrated on first read.
  const PERSIST_FILE = "messages.json";
  const LEGACY_LS_KEY = "aethon-messages";
  const MAX_MESSAGES = 200;

  // Restore on mount. First read disk; if empty, migrate any legacy
  // localStorage value the first build wrote. Tracked as state (not a ref)
  // so the persistence effect re-runs once restore completes — otherwise a
  // message that arrived during the async read window would never trigger
  // a disk write on a fresh install.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    (async () => {
      const raw = await readStateWithLocalStorageFallback(
        PERSIST_FILE,
        LEGACY_LS_KEY,
      );
      try {
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Restore into the default tab. Prepend before any messages
            // that landed during the async read window (agent-stderr,
            // an early send, …) and dedupe by id so a re-mount doesn't
            // double up. Multi-tab persistence is per-default-tab only
            // for now; per-tab restore is a follow-up.
            setState((prev) => {
              const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
              const idx = tabs.findIndex((t) => t.id === "default");
              if (idx < 0) return prev;
              const live = tabs[idx].messages;
              const seen = new Set(live.map((m) => m.id));
              const merged = [
                ...(parsed as ChatMessage[]).filter((m) => !seen.has(m.id)),
                ...live,
              ];
              tabs[idx] = { ...tabs[idx], messages: merged };
              const result: Record<string, unknown> = { ...prev, tabs };
              if (prev.activeTabId === "default") result.messages = merged;
              return result;
            });
          }
        }
      } catch {
        /* corrupt — ignore */
      } finally {
        setRestored(true);
      }
    })();
  }, []);

  // Debounced write of the default tab's messages. Skipped until the
  // initial restore completes so we don't overwrite the on-disk file
  // with the empty boot state. Other tabs aren't persisted yet — they
  // exist only for the lifetime of the app session.
  const persistTimerRef = useRef<number | null>(null);
  const defaultTabMessages = useMemo(() => {
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    return tabs.find((t) => t.id === "default")?.messages ?? [];
  }, [state.tabs]);
  useEffect(() => {
    if (!restored) return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const slim = defaultTabMessages.slice(-MAX_MESSAGES).map(trimMessage);
      writeState(PERSIST_FILE, JSON.stringify(slim)).catch(() => {
        /* surfaced via console.warn in persist.ts */
      });
    }, 400);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, [defaultTabMessages, restored]);

  function clearChat() {
    // Clear only the active tab's messages. Only flush the persisted
    // history file when the active tab IS the default — non-default tabs
    // aren't persisted, so writing `[]` here would wipe the saved
    // default-tab history that's still showing under another tab.
    const wasDefault =
      (stateRef.current.activeTabId as string | undefined) === "default";
    updateActiveTab((tab) => ({ ...tab, messages: [] }));
    if (wasDefault) {
      writeState(PERSIST_FILE, "[]").catch(() => {
        /* ignore */
      });
    }
  }

  function toggleTerminal() {
    setState((prev) => {
      const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
      return { ...prev, terminal: { ...term, open: !term.open } };
    });
  }

  function toggleSidebar() {
    setState((prev) => {
      // Flip /layout/sidebarVisible AND swap /layout/columns +
      // /layout/areas atomically so the grid template adapts on
      // the same frame the sidebar cell hides. Without the
      // template swap the hidden sidebar would still reserve its
      // 220px column. Workstation hoists tabs into the header
      // (5 rows total); other layouts (editorial / command-deck /
      // live-layout) own their own area templates and don't bind
      // /layout/areas, so this toggle stays workstation-shaped.
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

  async function stopPrompt() {
    const tabId = (stateRef.current.activeTabId as string | undefined) ?? "default";
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

  // ---------------------------------------------------------------------
  // Tab update helpers. `updateTab` writes into one tab record; if that
  // tab is currently active, it ALSO updates the root mirror keys so the
  // layout sees the change. `updateActiveTab` is a thin wrapper that
  // resolves the active id from the latest state. `mirrorKeys` lists the
  // tab fields that ride along on the root state.
  // ---------------------------------------------------------------------
  const TAB_MIRROR_KEYS: (keyof Tab)[] = [
    "messages",
    "draft",
    "waiting",
    "queueCount",
    "canvas",
    "model",
  ];

  function updateTab(tabId: string, mutator: (tab: Tab) => Tab) {
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      if (prev.activeTabId === tabId) {
        const nextRec = next as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = nextRec[key as string];
        }
      }
      return result;
    });
  }

  function updateActiveTab(mutator: (tab: Tab) => Tab) {
    setState((prev) => {
      const activeId = prev.activeTabId as string | undefined;
      if (!activeId) return prev;
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const idx = tabs.findIndex((t) => t.id === activeId);
      if (idx < 0) return prev;
      const next = mutator(tabs[idx]);
      tabs[idx] = next;
      const result: Record<string, unknown> = { ...prev, tabs };
      const nextRec = next as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = nextRec[key as string];
      }
      return result;
    });
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

  // Tell the shared xterm panel to clear and replay a tab's terminal
  // buffer. Used by every code path that changes the active tab — switch,
  // close, or the bridge's tab_closed forwarding — so the panel never
  // shows stale content from a tab that's no longer visible.
  function dispatchTerminalReplay(buffer: string) {
    // Microtask so xterm's mount-once useEffect has resolved before we
    // try to write to it (matters on the very first tab switch after
    // boot when the layout is rendering for the first time).
    Promise.resolve().then(() => {
      window.dispatchEvent(
        new CustomEvent("aethon:terminal-replay", { detail: buffer }),
      );
    });
  }

  // Switch the active tab. Re-mirrors the new tab's view to the root keys
  // so layout bindings update without needing a per-key refresh. Also
  // dispatches a replay event so the shared xterm panel clears and
  // re-writes the new tab's buffered output (the buffer survives switches
  // even though there's only one xterm instance on screen).
  function setActiveTab(tabId: string) {
    let nextBuffer = "";
    setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const target = tabs.find((t) => t.id === tabId);
      if (!target) return prev;
      nextBuffer = target.terminalBuffer ?? "";
      const result: Record<string, unknown> = { ...prev, activeTabId: tabId };
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
    dispatchTerminalReplay(nextBuffer);
  }

  // Latest state, kept in a ref so the aethon-debug skill can read it via
  // `window.__AETHON_STATE__()` without going through React's state lifecycle.
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---------------------------------------------------------------------
  // Tab actions. Each one updates local state AND tells the bridge so the
  // pi session map stays in sync. Used by both the keyboard shortcuts
  // below and the tab-strip UI's click handlers.
  // ---------------------------------------------------------------------
  // Per-tab promise that resolves once the bridge has accepted tab_open.
  // sendChat awaits this before invoking send_message so the bridge can't
  // race-create the tab via the chat path with the wrong model.
  // Map of tab id → in-flight tab_open Promise. Tracks pending so a
  // fast first chat on the new tab can await registration before sending.
  // The Promise's resolved value is unused (Tauri invoke returns
  // Promise<unknown>); we only care about completion.
  const pendingTabOpens = useRef(new Map<string, Promise<unknown>>());

  function newTab(
    restoreId?: string,
    restoreLabel?: string,
    options?: { restoredSession?: boolean },
  ) {
    // restoreId lets the caller open a tab with a specific tabId so the
    // bridge's SessionManager.continueRecent picks up the persisted
    // session for that id. Used by the empty-state's "Recent sessions"
    // list. Omitted for normal new-tab gestures (Cmd+T, +, menu).
    const id = restoreId ?? crypto.randomUUID();
    // Inherit the previously-active tab's model so the picker stays
    // consistent. Without this, the new tab's pi session would default
    // to whatever ~/.pi/agent/settings.json declares — which is often
    // outside the user's enabledModels glob and would leave the picker
    // showing nothing highlighted.
    const inheritedModel =
      ((stateRef.current.model as string | undefined) ?? "").trim();
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      // Use the restoreLabel when restoring a persisted session so the
      // user sees a meaningful name; otherwise fall back to the
      // sequential "Tab N" naming the empty-tab path has used.
      const label = restoreLabel ?? `Tab ${tabs.length + 1}`;
      const projectId = projectsRef.current.activeId;
      const messages: ChatMessage[] = options?.restoredSession
        ? [{
            id: crypto.randomUUID(),
            role: "system",
            text: "Restored session context. Continue the conversation to pick up where it left off.",
          }]
        : [];
      const tab: Tab = {
        ...makeEmptyTab(id, label, projectId),
        messages,
        model: inheritedModel,
      };
      tabs.push(tab);
      const result: Record<string, unknown> = {
        ...prev,
        tabs,
        activeTabId: id,
        // We're back from the empty-state — flip the layout's $ref-driven
        // visibility flags so the canvas/composer/tab-strip reappear and
        // the empty-state composite hides itself.
        empty: false,
        hasTabs: true,
      };
      const tabRec = tab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        result[key as string] = tabRec[key as string];
      }
      result.sidebar = recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        tab.model,
      );
      return result;
    });
    // Pass `model` with tab_open so the bridge spins up the pi session
    // with the inherited model from the start. Without this, a fast
    // first prompt can land before a follow-up set_model finishes —
    // the prompt would run on pi's default and lock the tab there
    // (set_model is rejected while a prompt is in flight).
    // The new tab starts with an empty terminal buffer — clear the
    // shared xterm so it doesn't keep showing the previous tab's
    // scrollback until the next switch / output event.
    dispatchTerminalReplay("");
    // The active project (if any) supplies the cwd for the new tab's pi
    // session. Tabs created before a project is picked use the bridge's
    // default cwd (the spawn directory). Existing tabs keep their original
    // cwd — switching project doesn't retroactively rebase live sessions.
    const inheritedCwd = activeProject(projectsRef.current)?.path;
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: id,
        ...(inheritedModel ? { model: inheritedModel } : {}),
        ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
      }),
    });
    // Track until done so a fast first chat on the new tab can wait
    // for the bridge to register the tab + initial model before send.
    // Otherwise send_message would race tab_open and the bridge would
    // lazily create the tab session with pi's default model.
    pendingTabOpens.current.set(id, opening);
    opening
      .catch((err) => {
        appendSystem(`Failed to open tab: ${err}`);
      })
      .finally(() => {
        pendingTabOpens.current.delete(id);
      });
  }

  function autoRestoreDiscoveredSessions(
    discovered: { tabId: string; lastModified: number }[],
    knownIds: Set<string>,
  ) {
    if (discovered.length === 0) return;
    getConfig()
      .then((config) => {
        if (!config.ui.restoreTabs) return;
        const liveIds = new Set([
          ...knownIds,
          ...(((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => t.id)),
        ]);
        const toRestore = discovered
          .filter((d) => !liveIds.has(d.tabId))
          .filter((d) => !autoRestoredSessionIdsRef.current.has(d.tabId))
          .slice(0, 8);
        if (toRestore.length === 0) return;
        // Open oldest first so the most recent session ends up active.
        for (const session of [...toRestore].reverse()) {
          autoRestoredSessionIdsRef.current.add(session.tabId);
          newTab(session.tabId, `Session ${session.tabId.slice(0, 8)}`);
        }
        pushNotification({
          id: "ae-auto-restore-tabs",
          title: `Restored ${toRestore.length} session${toRestore.length === 1 ? "" : "s"}`,
          kind: "success",
          durationMs: 3000,
        });
      })
      .catch(() => {
        /* config read already logs; manual restore remains available */
      });
  }

  function nextTab(direction: 1 | -1) {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    if (tabs.length <= 1) return;
    const activeId = stateRef.current.activeTabId as string | undefined;
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (idx < 0) return;
    const nextIdx = (idx + direction + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIdx].id);
  }

  function closeTab(tabId: string) {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    if (tabs.length === 0) return; // already empty — nothing to close
    let nextBuffer = "";
    let switched = false;
    let becameEmpty = false;
    setState((prev) => {
      const list = ((prev.tabs as Tab[] | undefined) ?? []).filter((t) => t.id !== tabId);
      let activeTabId = prev.activeTabId as string | undefined;
      // Choose a new active tab. When list is empty, we drop into the
      // empty-state composite (no active tab; layout swaps via /empty).
      if (activeTabId === tabId) {
        activeTabId = list.length > 0 ? list[list.length - 1].id : undefined;
        switched = true;
      }
      const result: Record<string, unknown> = { ...prev, tabs: list, activeTabId };
      if (list.length === 0) {
        becameEmpty = true;
        // Clear mirrored keys so stale per-tab state doesn't bleed
        // through the empty-state view (the composer's value, the
        // canvas, etc. shouldn't render any prior tab's data).
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = undefined;
        }
        result.empty = true;
        result.hasTabs = false;
      } else {
        const target = list.find((t) => t.id === activeTabId)!;
        nextBuffer = target.terminalBuffer ?? "";
        const targetRec = target as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = targetRec[key as string];
        }
        result.sidebar = recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          target.model,
        );
        result.empty = false;
        result.hasTabs = true;
      }
      return result;
    });
    // If the closed tab was the active one, the visible terminal was
    // showing its buffer — replay the new active tab's buffer (or empty
    // string when no tabs remain) so the shared xterm doesn't keep
    // displaying the dead tab's output.
    if (switched) dispatchTerminalReplay(nextBuffer);
    if (becameEmpty) {
      // Tell the bridge to tear down the session too. tab_close on an
      // empty Map is a no-op on the bridge side; gracefully handled.
      invoke("agent_command", {
        payload: JSON.stringify({ type: "tab_close", tabId }),
      }).catch(() => {
        /* ignore — UI already closed */
      });
    } else {
      invoke("agent_command", {
        payload: JSON.stringify({ type: "tab_close", tabId }),
      }).catch(() => {
        /* ignore — UI already closed */
      });
    }
  }

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
      // Cmd+` toggles the terminal panel. Mirrors VS Code / iTerm.
      if (e.key === "`" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
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
      // Cmd+T → new tab. Pi sessions are independent per tab.
      if (e.key.toLowerCase() === "t" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        newTab();
        return;
      }
      // Cmd+] → next tab; Cmd+[ → previous. Matches macOS browser
      // conventions (Safari/Chrome use Cmd+Shift+] but Cmd+] alone is
      // common in IDE tab cycling).
      if (e.key === "]" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        nextTab(1);
        return;
      }
      if (e.key === "[" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        nextTab(-1);
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
      if (mod && !e.altKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        resetZoom();
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
      // layouts (workstation, editorial, command-deck, live-layout)
      // without having to ship a full setLayout payload. Extensions
      // append more via
      // registerLayout. Activation goes through setLayout so all the
      // existing state-merge / layout-bound-state semantics apply.
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
  useEffect(() => {
    // Snapshot the watched slices. Each entry maps a JSON-Pointer-like
    // path the bridge will store under to a value the frontend computes
    // from current state.
    const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    const messagesCount = ((state.messages as unknown[] | undefined) ?? []).length;
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

    const unlistenReload = listen<string>("agent-reloaded", () => {
      activeResponseIdRef.current = null;
      setStatusFlags({ waiting: false, status: "agent reloaded" });
      // Re-prime the agent so we get a fresh `ready` event with the new code.
      invoke("start_agent").catch(() => {
        /* surfaced by the next user action */
      });
    });

    // Mirror agent stderr into the chat as a system message — when the bridge
    // dies on startup this is the only signal we have.
    const unlistenStderr = listen<string>("agent-stderr", (event) => {
      const text = event.payload?.toString().trim();
      if (!text) return;
      // Cap noise — only surface lines that look like errors. Bun and pi-ai
      // emit informational stderr (e.g. cache hits) we can ignore.
      if (/error|throw|fatal|cannot|fail|exception/i.test(text)) {
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
        case "new_tab": newTab(); break;
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

    return () => {
      unlistenResponse.then((fn) => fn());
      unlistenReload.then((fn) => fn());
      unlistenStderr.then((fn) => fn());
      unlistenMenu.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ack a mutation back to the bridge so the awaiting Promise resolves.
  // Called from every mutation case in handleAgentMessage that successfully
  // applied (or rejected) the change. Fire-and-forget — we don't await the
  // ack-send because the bridge ack channel is independent of any other
  // outgoing message.
  function ackMutation(mutationId: unknown, success: boolean, error?: string) {
    if (typeof mutationId !== "string" || mutationId.length === 0) return;
    invoke("agent_command", {
      payload: JSON.stringify({
        type: "mutation_ack",
        mutationId,
        success,
        ...(error ? { error } : {}),
      }),
    }).catch(() => {
      /* bridge gone — extension's awaiter will hit the timeout instead */
    });
  }

  function handleAgentMessage(data: { type?: string; [k: string]: unknown }) {
    switch (data.type) {
      case "ready": {
        const model = (data.model as string) || "";
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
        const extStateKeys = ((data.extensionStateKeys as string[] | undefined) ?? []);
        const discTabs = (data.discoveredTabs as
          | { tabId: string; lastModified: number }[]
          | undefined) ?? [];
        // Hydrate extension themes BEFORE the layout state merge below so
        // /sidebar/themes carries the full list (built-ins + extension)
        // when the merge runs. hydrateThemes also injects the CSS so a
        // saved choice has the rule available before data-theme is read.
        hydrateThemes(extThemes);
        registry.setTemplates(extComponents);
        // Restore extension-registered slash commands so the picker shows
        // them on first paint (no need to wait for an extension_slash_commands
        // delta after reload). hydrateSlashCommands rewrites the merged
        // catalog (built-ins + extensions), updates the picker state ref,
        // and bumps /slashCommands so the picker re-resolves via $ref.
        hydrateSlashCommands(extSlash);
        hydrateKeybindings(extKeys);
        hydrateEventRoutes(extEventRoutes, extEventRoutingMode);
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
        const knownIds = new Set(
          (((data.tabs as { id: string }[] | undefined) ?? []).map((t) => t.id))
            .concat(((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => t.id))
            .concat(["default"]),
        );
        const recentSessions = discTabs
          .filter((d) => !knownIds.has(d.tabId))
          .slice(0, 8)
          .map((d) => ({
            id: d.tabId,
            label: `Session ${d.tabId.slice(0, 8)}`,
            lastModified: formatRelativeTime(d.lastModified),
          }));
        autoRestoreDiscoveredSessions(discTabs, knownIds);
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
        break;
      }
      case "extension_components": {
        const components = (data.components as Record<string, unknown>) ?? {};
        registry.setTemplates(components);
        ackMutation(data.mutationId, true);
        break;
      }
      case "extension_themes": {
        const themes = (data.themes as ExtensionTheme[] | undefined) ?? [];
        hydrateThemes(themes);
        ackMutation(data.mutationId, true);
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
        updateTab(tabId, (tab) => ({
          ...tab,
          waiting: true,
          ...(remaining !== undefined ? { queueCount: remaining } : {}),
        }));
        if (stateRef.current.activeTabId === tabId) {
          setState((prev) => ({ ...prev, status: "thinking…" }));
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

  // Projects (working directories the agent operates in). Persisted to
  // ~/.aethon/projects.json. The active project's path travels with each
  // new tab as `cwd` on `tab_open` so pi's SessionManager scopes the
  // session to that directory. Existing tabs keep their original cwd —
  // switching project doesn't retroactively change live sessions.
  const projectsRef = useRef<ProjectsState>(emptyProjectsState());

  // Cached git status keyed by absolute project path. Populated by the
  // poller below (refreshGitStatusFor) and read by syncProjectsToState
  // when mirroring projects into /sidebar/projects. Kept in a ref so
  // a status update can re-trigger sync without re-scheduling all the
  // other project work.
  interface GitStatus {
    branch?: string;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
  }
  const gitStatusRef = useRef<Map<string, GitStatus>>(new Map());

  // Tab buckets keyed by project (or NO_PROJECT_KEY). When the user
  // switches active project, we snapshot the current state.tabs +
  // activeTabId into the OLD bucket and load the NEW bucket into state
  // — that's how tabs become per-project visible without us having to
  // filter on every render. New tabs get the active projectId baked in
  // (see newTab) so the bucket they end up in matches their tag.
  const tabBucketsRef = useRef<
    Map<string, { tabs: Tab[]; activeTabId: string | undefined }>
  >(new Map());

  // Mirror the projects state into app state so layouts can $ref it.
  // Bumps `/projects`, `/activeProjectId`, `/project/{label,path,id}`,
  // `/sessionLabel` (used by editorial header subtitle) and
  // `/sidebar/projects` (sidebar item array). Called on every mutation
  // so a single helper keeps the shape consistent. Carries the cached
  // git status from gitStatusRef so a sync triggered for non-git
  // reasons (lastUsed bump, label change) doesn't drop the badges.
  function syncProjectsToState() {
    const ps = projectsRef.current;
    const active = activeProject(ps);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
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

  // Tell the bridge what `cwd` to use for new sessions on a given tab.
  // The bridge accepts a `cwd` field on `tab_open`; on `set_project` it
  // updates the per-tab record but doesn't tear down an in-flight session
  // (changing cwd mid-flight is a user-visible footgun). Fire-and-forget.
  function announceProjectToBridge(tabId: string, cwd: string | null) {
    invoke("agent_command", {
      payload: JSON.stringify({ type: "set_project", tabId, cwd }),
    }).catch(() => {
      /* bridge gone — next tab_open re-announces */
    });
  }

  // Refresh the cached git status for one project path. Best-effort —
  // a missing `git` binary or a non-repo path resolves to an empty
  // entry and is treated as "no badge". Runs through the Tauri command
  // (gated by debug-or-release; both expose `git_status`).
  async function refreshGitStatusFor(path: string) {
    try {
      const status = await invoke<GitStatus | null>("git_status", { path });
      if (status) {
        gitStatusRef.current.set(path, status);
      } else {
        gitStatusRef.current.delete(path);
      }
      syncProjectsToState();
    } catch {
      // Tauri command threw — ignore so a transient git failure
      // doesn't blank the chip on subsequent successful polls.
    }
  }
  // Refresh every known project. Sequenced (not parallel) so a user with
  // a long projects list doesn't fork N git processes at once. Cheap
  // even at the upper bound (MAX_PROJECTS=16 in projects.ts).
  async function refreshAllGitStatus() {
    const list = projectsRef.current.projects.slice();
    for (const p of list) {
      await refreshGitStatusFor(p.path);
    }
  }

  // Periodic + focus-driven git poller. Initial pass right after
  // projects load; then every 30s, plus an immediate pass when the
  // window regains focus (user came back from terminal / browser and
  // likely committed something). Uses a guard ref so two overlapping
  // refreshes never run.
  const gitPollingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || gitPollingRef.current) return;
      gitPollingRef.current = true;
      try {
        await refreshAllGitStatus();
      } finally {
        gitPollingRef.current = false;
      }
    };
    void tick();
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load projects once at boot. Done in its own effect so a slow disk
  // doesn't push out the agent-start path. Mirrors into state on resolve
  // so the sidebar populates without a re-render trigger.
  useEffect(() => {
    (async () => {
      const ps = await loadProjects();
      projectsRef.current = ps;
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
      const result: Record<string, unknown> = {
        ...prev,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
      };
      const activeTab = next.tabs.find((t) => t.id === next.activeTabId);
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
    projectsRef.current = {
      projects: ps.projects.map((p) =>
        p.id === id ? { ...p, lastUsed: Date.now() } : p,
      ),
      activeId: id,
    };
    persistProjects();
    switchProjectBucket(fromKey, toKey);
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    announceProjectToBridge(tabId, target.path);
    return true;
  }

  function clearActiveProject() {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    projectsRef.current = { ...projectsRef.current, activeId: null };
    persistProjects();
    switchProjectBucket(fromKey, NO_PROJECT_KEY);
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    announceProjectToBridge(tabId, null);
  }

  function removeProjectById(id: string): boolean {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const wasActive = projectsRef.current.activeId === id;
    const removedKey = projectBucketKey(id);
    const result = removeProject(projectsRef.current, id);
    if (!result.removed) return false;

    projectsRef.current = result.state;
    gitStatusRef.current.delete(result.removed.path);
    persistProjects();

    if (wasActive) {
      switchProjectBucket(fromKey, NO_PROJECT_KEY);
      const tabId =
        (stateRef.current.activeTabId as string | undefined) ?? "default";
      announceProjectToBridge(tabId, null);
      tabBucketsRef.current.delete(removedKey);
    } else {
      tabBucketsRef.current.delete(removedKey);
    }

    return true;
  }

  // Walk the layout tree and produce a deduped, sorted list of component
  // types found in it. Lets the live-layout sidebar's "components in
  // layout" section derive from the actual active payload instead of
  // a hardcoded sample list. Keeps the entry shape sidebar items expect
  // ({id, label, active}). Active is set true for every type since the
  // layout DOES contain it; clicking does nothing today.
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

  // Refresh /sidebar/components whenever the layout changes so the
  // live-layout's inspector pane reflects what's actually rendered.
  // setState here is the React → state-derived-from-prop pattern; the
  // lint rule's blanket warning is the "avoid cascading renders"
  // heuristic, and the alternative (computing on each render and
  // injecting at $ref resolve time) would couple the sidebar component
  // to the layout shape — exactly what the JSON-pointer indirection
  // exists to avoid.
  useEffect(() => {
    const list = summarizeLayoutComponents(layout);
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // layouts have different grid SHAPES (workstation: 2 cols,
      // live-layout: 3 cols). deepMergeState keeps prev's columns,
      // which would mean a 2-col grid carrying the inspector pane has
      // nowhere to render. So force-take the seed's columns, then
      // patch the leading sidebar token with the user's persisted
      // width so cross-layout resizing feels continuous.
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

  // ---------------------------------------------------------------------
  // Command palette helpers — open/close/run. The palette renders at App
  // root over every layout. Items are derived in the component itself
  // (selectPaletteItems) from existing state slices, so opening with a
  // mode is enough — no items list to populate here.
  // ---------------------------------------------------------------------
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
        newTab(p.sessionId, p.label);
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
        else if (p.action === "builtin:meta+`") toggleTerminal();
        else if (p.action === "builtin:meta+k") clearChat();
        else if (p.action === "builtin:meta+.") void stopPrompt();
        else if (p.action === "builtin:meta+p") openPalette("switcher");
        else if (p.action === "builtin:meta+shift+p") openPalette("commands");
        else if (p.action === "builtin:meta+=") adjustZoom(0.1);
        else if (p.action === "builtin:meta+-") adjustZoom(-0.1);
        else if (p.action === "builtin:meta+0") resetZoom();
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
      listSkills: () => registry.list().map((s) => s.name),
      installSkill: async (spec: string) => {
        return await invoke<string>("install_aethon_skill", { spec });
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
          dismissNotification(id);
          return true;
        }
        if (eventType === "action" && id) {
          const action = (data as { action?: string } | undefined)?.action;
          // Forward action strings as their own a2ui_event so paired
          // aethon.onEvent matchers fire. Built-in actions are handled
          // by the agent / extensions; nothing to short-circuit here.
          if (action) {
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
      // The header command-bar (used by command-deck layout) fires
      // `invoke` on click/tap. Open the palette in switcher mode so
      // the chrome affordance is now actually wired up.
      if (component.id === "command-bar" && eventType === "invoke") {
        openPalette("switcher");
        return true;
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
      // (workstation hoists the strip into the header as `header-tabs`,
      // editorial uses `editorial-header`, command-deck uses
      // `vertical-tab-rail`). Matching by type keeps the contract layout-
      // agnostic so a new layout's tabs work without touching App.tsx.
      const tabType = component.type;
      const isTabSurface =
        tabType === "tab-strip" ||
        tabType === "editorial-header" ||
        tabType === "vertical-tab-rail";
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
        // Vertical-tab-rail's project shelf — clicking a project row
        // switches the active project. id matches a sidebar project id;
        // unknown ids fall through (no-op) so other layouts can ride the
        // same shelf channel without crashing.
        if (eventType === "shelf" && sel?.id) {
          if (setActiveProjectById(sel.id)) return true;
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
            | { sessionId?: string; label?: string }
            | undefined;
          if (sel?.sessionId) {
            // Re-open the persisted session by reusing the same tabId.
            // The bridge's SessionManager.continueRecent reads the
            // existing JSONL files so the LLM history is restored too.
            newTab(sel.sessionId, sel.label ?? "Restored Session", {
              restoredSession: true,
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

  // Synthetic A2UIComponent for App-root chrome (palette / notification
  // stack). The palette + stack expect BuiltinComponentProps so we can
  // also embed them inside layout JSON if a skill chooses to — at root
  // we hand-feed the same shape.
  const paletteComponent = useMemo(
    () => ({ id: "command-palette", type: "command-palette", props: {} }),
    [],
  );
  const notificationComponent = useMemo(
    () => ({ id: "notification-stack", type: "notification-stack", props: {} }),
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
    return {
      ...state,
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
        <NotificationStack
          component={notificationComponent}
          state={renderState}
          onEvent={(eventType, data) =>
            onEvent(notificationComponent, eventType, data)
          }
        />
        <CommandPalette
          component={paletteComponent}
          state={renderState}
          onEvent={(eventType, data) =>
            onEvent(paletteComponent, eventType, data)
          }
        />
      </div>
    </SkillRegistryProvider>
  );
}
