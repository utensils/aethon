import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import A2UIRenderer from "./components/A2UIRenderer";
import { SkillRegistry, SkillRegistryProvider } from "./skills/registry";
import { defaultLayoutSkill } from "./skills/default-layout";
import type { A2UIPayload, ChatMessage } from "./types/a2ui";
import type { A2UISkill } from "./skills/types";
import { setPointer } from "./utils/jsonPointer";
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

// The default-layout skill ships a layout — that's the boot payload.
const BOOT_LAYOUT: A2UIPayload = defaultLayoutSkill.layout!;

interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
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
  }
  function makeEmptyTab(id: string, label: string): Tab {
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
    };
  }
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

  // Themes — built-in `dark`/`light` plus extension-registered ones. Persisted
  // to `~/.aethon/theme` so the choice survives reloads.
  // Resolution priority: per-session disk file → config.toml `[ui] theme`
  // → OS `prefers-color-scheme` → dark. Migrates the legacy
  // `aethon-theme` localStorage entry on first read.
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
    { id: "dark", label: "Dark" },
    { id: "light", label: "Light" },
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
      return {
        ...prev,
        sidebar: {
          ...sidebar,
          themes: [...BUILTIN_THEMES, ...list.map((t) => ({ id: t.id, label: t.label }))],
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
      const initial =
        trimmed.length > 0
          ? trimmed
          : config.ui.theme
            ? config.ui.theme
            : window.matchMedia?.("(prefers-color-scheme: light)").matches
              ? "light"
              : "dark";
      document.documentElement.dataset.theme = initial;
    })();
  }, []);

  function setTheme(id: string) {
    document.documentElement.dataset.theme = id;
    writeState("theme", id).catch(() => {
      /* ignore */
    });
  }

  // Persistent chat history — restore on mount, write debounced on change.
  // Cap at 200 messages and 8KB per text field. Storage is `~/.aethon/messages.json`
  // via Tauri commands; the previous localStorage key is migrated on first read.
  const PERSIST_FILE = "messages.json";
  const LEGACY_LS_KEY = "aethon-messages";
  const MAX_MESSAGES = 200;
  const MAX_TEXT_BYTES = 8 * 1024;

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
      (c.props.src as string).startsWith("data:")
    ) {
      next = { ...c, props: { ...c.props, src: "", caption: "[image dropped from history]" } };
    }
    if (Array.isArray(c.children) && c.children.length > 0) {
      next = { ...next, children: c.children.map(stripImageDataUrls) };
    }
    return next;
  }

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
  const pendingTabOpens = useRef(new Map<string, Promise<void>>());

  function newTab() {
    const id = crypto.randomUUID();
    // Inherit the previously-active tab's model so the picker stays
    // consistent. Without this, the new tab's pi session would default
    // to whatever ~/.pi/agent/settings.json declares — which is often
    // outside the user's enabledModels glob and would leave the picker
    // showing nothing highlighted.
    const inheritedModel =
      ((stateRef.current.model as string | undefined) ?? "").trim();
    setState((prev) => {
      const tabs = ((prev.tabs as Tab[] | undefined) ?? []).slice();
      const label = `Tab ${tabs.length + 1}`;
      const tab: Tab = { ...makeEmptyTab(id, label), model: inheritedModel };
      tabs.push(tab);
      const result: Record<string, unknown> = { ...prev, tabs, activeTabId: id };
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
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: id,
        ...(inheritedModel ? { model: inheritedModel } : {}),
      }),
    }) as Promise<void>;
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
    if (tabs.length <= 1) return; // never close the last tab
    if (tabId === "default") return; // bridge refuses; keep parity
    let nextBuffer = "";
    let switched = false;
    setState((prev) => {
      const list = ((prev.tabs as Tab[] | undefined) ?? []).filter((t) => t.id !== tabId);
      let activeTabId = prev.activeTabId as string | undefined;
      if (activeTabId === tabId) {
        activeTabId = list[list.length - 1].id;
        switched = true;
      }
      const result: Record<string, unknown> = { ...prev, tabs: list, activeTabId };
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
      return result;
    });
    // If the closed tab was the active one, the visible terminal was
    // showing its buffer — replay the new active tab's buffer so the
    // shared xterm doesn't keep displaying the dead tab's output.
    if (switched) dispatchTerminalReplay(nextBuffer);
    invoke("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId }),
    }).catch(() => {
      /* ignore — UI already closed */
    });
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
      const mod = e.metaKey || e.ctrlKey;
      // Cmd+` toggles the terminal panel. Mirrors VS Code / iTerm.
      if (e.key === "`" && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setState((prev) => {
          const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
          return { ...prev, terminal: { ...term, open: !term.open } };
        });
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
  }, [layout, registry]);

  useEffect(() => {
    (async () => {
      try {
        await invoke("start_agent");
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
      switch (id) {
        case "new_tab": newTab(); break;
        case "close_tab": {
          const activeId = stateRef.current.activeTabId as string | undefined;
          if (activeId) closeTab(activeId);
          break;
        }
        case "next_tab": nextTab(1); break;
        case "prev_tab": nextTab(-1); break;
        case "toggle_terminal": {
          setState((prev) => {
            const term = (prev.terminal as { open?: boolean }) ?? {};
            return { ...prev, terminal: { ...term, open: !term.open } };
          });
          break;
        }
        case "clear_chat": clearChat(); break;
        case "stop_prompt": {
          const tabId = (stateRef.current.activeTabId as string | undefined) ?? "default";
          invoke("agent_command", {
            payload: JSON.stringify({ type: "stop", tabId }),
          }).catch(() => { /* surfaced by chat */ });
          break;
        }
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
        // Hydrate extension themes BEFORE the layout state merge below so
        // /sidebar/themes carries the full list (built-ins + extension)
        // when the merge runs. hydrateThemes also injects the CSS so a
        // saved choice has the rule available before data-theme is read.
        hydrateThemes(extThemes);
        registry.setTemplates(extComponents);
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
        setState((prev) => {
          // Three-layer hydration in priority order (lowest → highest):
          //   1. extension layout state — TREATED AS BOOT DEFAULTS
          //      (only fills keys not already set; existing live state
          //      like `messages` / `canvas` wins to avoid wiping
          //      restored history when ready replays after a reload)
          //   2. extension setState patches (last-write-wins overrides)
          //   3. ready-owned runtime fields (model picker, status, etc.)
          //
          // Known limitation: keys an extension wrote earlier in the
          // session via setState are NOT cleared when that extension
          // stops reporting them (e.g. uninstalled mid-session). They
          // survive in `prev` and re-appear here. Reset Aethon to clear
          // — fix would require the bridge tracking extension-owned
          // keys explicitly. Acceptable for the current scope.
          let next: Record<string, unknown> = { ...prev };
          if (extLayout && extLayout.state) {
            // Defaults semantics: deep-merge layout into a fresh object
            // and let prev win for any overlapping keys.
            next = deepMergeState(
              extLayout.state as Record<string, unknown>,
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
              localTabs.push({ ...makeEmptyTab(bt.id, label), model: bt.model });
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
            sidebar: {
              ...((next.sidebar as Record<string, unknown>) ?? {}),
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
          const opening = invoke("agent_command", {
            payload: JSON.stringify({
              type: "tab_open",
              tabId: t.id,
              ...(t.model ? { model: t.model } : {}),
            }),
          }) as Promise<void>;
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
        break;
      }
      case "extension_themes": {
        const themes = (data.themes as ExtensionTheme[] | undefined) ?? [];
        hydrateThemes(themes);
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
        if (!path) break;
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
        }
        break;
      }
      case "layout_set": {
        // Extension swapped the active layout wholesale. Goes through
        // the same path window.aethon.setLayout uses so the new payload
        // hydrates state and renders identically to a default-layout boot.
        const next = data.payload as A2UIPayload | undefined;
        if (!next || typeof next !== "object" || !Array.isArray(next.components)) break;
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
        if (!path) break;
        setLayout((prev) => layoutPatch(prev, path, data.value));
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
        const message = (data.message as string) ?? "";
        const tabId = (data.tabId as string | undefined) ?? "default";
        if (message) {
          appendMessage(
            { id: crypto.randomUUID(), role: "system", text: message },
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
        // older content rotates out first). When the tab is active, also
        // dispatch the live-stream event so xterm writes the chunk
        // immediately without waiting for a state-driven re-render.
        updateTab(tabId, (tab) => {
          const next = (tab.terminalBuffer ?? "") + content;
          const trimmed = next.length > TERMINAL_REPLAY_MAX
            ? next.slice(next.length - TERMINAL_REPLAY_MAX)
            : next;
          return { ...tab, terminalBuffer: trimmed };
        });
        if ((stateRef.current.activeTabId as string | undefined) === tabId) {
          window.dispatchEvent(
            new CustomEvent("aethon:terminal", { detail: content }),
          );
        }
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

  // Built once — handlers close over App-scope helpers via the ctx passed at
  // dispatch time, so the registry itself doesn't need state in scope.
  const slashCommandsRef = useRef<SlashCommand[]>(buildBuiltinSlashCommands());

  // Surface the slash command list into layout state so the chat-input
  // autocomplete can resolve it via `$ref:/slashCommands`. Done once on
  // mount because the registry is static for now (skill-registered
  // commands will arrive in a later phase and trigger an update then).
  useEffect(() => {
    setState((prev) => ({
      ...prev,
      slashCommands: slashCommandsRef.current.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
      })),
    }));
  }, []);

  function appendSystem(text: string) {
    appendMessage({ id: crypto.randomUUID(), role: "system", text });
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
      clearChat,
      setTheme,
      listThemes,
      setModel,
      resetLayout: () => setLayout(BOOT_LAYOUT),
      listSkills: () => registry.list().map((s) => s.name),
      listModels: () => {
        const sidebar = (stateRef.current.sidebar as Record<string, unknown>) ?? {};
        return ((sidebar.models as { id: string; label: string; active?: boolean }[]) ?? []);
      },
      toggleTerminal: () =>
        setState((prev) => {
          const term = (prev.terminal as { open?: boolean }) ?? {};
          return { ...prev, terminal: { ...term, open: !term.open } };
        }),
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
    () => async (component: { id: string }, eventType: string, data?: unknown) => {
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
        return true;
      }
      if (component.id === "tab-strip") {
        const sel = data as { tabId?: string; action?: string } | undefined;
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
      if (component.id === "sidebar" && eventType === "select") {
        const selected = data as { sectionId?: string; itemId?: string } | undefined;
        if (selected?.itemId === "toggle-terminal") {
          setState((prev) => {
            const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
            return { ...prev, terminal: { ...term, open: !term.open } };
          });
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
      }
      return false;
    },
    [],
  );

  return (
    <SkillRegistryProvider registry={registry}>
      <div className="app">
        <A2UIRenderer
          payload={layout}
          state={state}
          onStateChange={setState}
          onEvent={onEvent}
          tabId={state.activeTabId as string | undefined}
        />
      </div>
    </SkillRegistryProvider>
  );
}
