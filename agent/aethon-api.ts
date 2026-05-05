/**
 * Factory that builds the `globalThis.aethon` object — the API surface
 * extensions and the agent see when calling registration/mutation methods.
 *
 * Every method is a thin wrapper over a focused helper module
 * (mutation-ack, layout-manager, event-routes, ...). The factory takes
 * the shared {@link AethonAgentState} instance and the side-effect deps
 * (`send`, `scheduleStateFileWrite`) and binds them; the resulting object
 * has plain-function methods so destructuring still works
 * (`const { setState } = aethon`).
 */

import type {
  A2UIEventHandler,
  A2UIEventMatch,
  AethonAgentState,
  ExtensionSource,
  LayoutSlotsCatalogue,
  MutationResult,
  ThemeRecord,
} from "./state";
import { trackMutation } from "./mutation-ack";
import { dismissNotification, notify } from "./notifications";
import {
  canonicalizeCombo,
  registerKeybinding,
  unregisterKeybinding,
} from "./keybindings";
import {
  listEventRoutes,
  onEvent,
  registerEventRoute,
  setEventRoutingMode,
  unregisterEventRoute,
} from "./event-routes";
import {
  getLayout,
  getLayoutSlots,
  listLayouts,
  patchLayout,
  registerLayout,
  setLayout,
  unregisterLayout,
} from "./layout-manager";
import {
  EXT_STATE_LOG_WINDOW_MS,
  makeCanvasApi,
  setState,
} from "./state-mutation";
import { makeExtStateLogLimiter } from "./state-limits";
import { normalizeTheme, RESERVED_THEME_IDS } from "./extension-loader";
import type { CanvasApi } from "./canvas";
import type { RuntimeSnapshot } from "./system-prompt";

export interface AethonApiDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
  getRuntimeSnapshot: () => RuntimeSnapshot;
}

const SHELL_WRITE_ACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — user may step away
const MUTATION_ACK_TIMEOUT_MS_DEFAULT = 5_000;

/** Built-in slash command names — extensions cannot shadow these.
 *  Keeps independent of frontend imports so the bridge can decide. */
const BUILTIN_SLASH_NAMES = new Set([
  "clear",
  "help",
  "theme",
  "model",
  "reset",
  "terminal",
  "extensions",
  "sidebar",
  "layout",
  "project",
]);

export interface ShellsApi {
  list(): Promise<MutationResult>;
  read(input: {
    tabId: string;
    sinceTotal?: number;
    maxBytes?: number;
  }): Promise<MutationResult>;
  write(input: { tabId: string; text: string }): Promise<MutationResult>;
}

export interface AethonApi {
  registerComponent: (
    componentType: string,
    template: unknown,
  ) => Promise<MutationResult>;
  setState: (
    path: string,
    value: unknown,
    sourceTabId?: string,
  ) => Promise<MutationResult>;
  onEvent: (match: A2UIEventMatch, handler: A2UIEventHandler) => void;
  onUnload: (fn: () => void | Promise<void>) => void;
  setLayout: (payload: unknown) => Promise<MutationResult>;
  patchLayout: (path: string, value: unknown) => Promise<MutationResult>;
  registerSidebarSection: (section: {
    id: string;
    title: string;
    items?: { id: string; label: string; active?: boolean }[];
  }) => Promise<MutationResult>;
  registerTheme: (theme: unknown) => Promise<MutationResult>;
  registerHighlightGrammar: (
    lang: unknown,
    grammar: unknown,
  ) => Promise<MutationResult>;
  registerSlashCommand: (cmd: unknown) => Promise<MutationResult>;
  registerLayout: (entry: unknown) => Promise<MutationResult>;
  unregisterLayout: (id: unknown) => Promise<MutationResult>;
  listLayouts: () => { id: string; name: string; description?: string }[];
  registerKeybinding: (binding: unknown) => Promise<MutationResult>;
  unregisterKeybinding: (combo: unknown) => Promise<MutationResult>;
  registerMenuItem: (item: unknown) => Promise<MutationResult>;
  unregisterMenuItem: (id: unknown) => Promise<MutationResult>;
  notify: (input: unknown) => Promise<MutationResult>;
  dismissNotification: (id: unknown) => Promise<MutationResult>;
  registerEventRoute: (route: unknown) => Promise<MutationResult>;
  unregisterEventRoute: (route: unknown) => Promise<MutationResult>;
  listEventRoutes: () => { componentId?: string; eventType?: string }[];
  setEventRoutingMode: (mode: unknown) => Promise<MutationResult>;
  listExtensions: () => { name: string; source: ExtensionSource }[];
  listComponents: () => Record<string, unknown>;
  listThemes: () => ThemeRecord[];
  getLayout: () => unknown;
  getLayoutSlots: () => LayoutSlotsCatalogue | null;
  getFrontendState: (path?: string) => unknown;
  getRuntimeSnapshot: () => RuntimeSnapshot;
  canvas: CanvasApi;
  shells: ShellsApi;
}

/** Build the aethon API and return it. Callers (main.ts) install it on
 *  `globalThis.aethon` themselves.
 *
 *  IMPORTANT: this builds the canvas helper with `boundTabId = undefined`
 *  so the global API.canvas.* calls resolve through ALS / current turn /
 *  frontend active / "default". Per-handler canvas helpers are built
 *  separately (see tab-lifecycle.ts) with a bound tabId. */
export function buildAethonApi(
  state: AethonAgentState,
  deps: AethonApiDeps,
): AethonApi {
  // One shared rate limiter for setState size-guard logging + the
  // `extension_runtime_error` notice. Without sharing, every setState
  // call would spin up a fresh limiter that always logs the first
  // invocation — defeating dedup and re-popping the "extension is
  // misbehaving" toast on every rejected write.
  const stateMutationDeps = {
    send: deps.send,
    extStateLogLimiter: makeExtStateLogLimiter(EXT_STATE_LOG_WINDOW_MS),
  };
  const layoutDeps = {
    send: deps.send,
    scheduleStateFileWrite: deps.scheduleStateFileWrite,
  };
  const eventDeps = layoutDeps;
  const keybindingsDeps = layoutDeps;
  const notifDeps = { send: deps.send };

  function _registerComponent(
    componentType: string,
    template: unknown,
  ): Promise<MutationResult> {
    if (!componentType || typeof componentType !== "string") {
      return Promise.resolve({ ok: false, error: "componentType required" });
    }
    // Accept both shapes:
    //   - bare component:    { id, type, props?, children? }
    //   - payload wrapper:   { components: [<single component>] }
    let normalized = template;
    if (
      template &&
      typeof template === "object" &&
      !("type" in template) &&
      Array.isArray((template as { components?: unknown }).components)
    ) {
      const wrapped = (template as { components: unknown[] }).components;
      if (wrapped.length === 1) normalized = wrapped[0];
    }
    state.extensionComponents.set(componentType, normalized);
    const { id, promise } = trackMutation(state);
    deps.send({
      type: "extension_components",
      mutationId: id,
      components: Object.fromEntries(state.extensionComponents),
    });
    deps.scheduleStateFileWrite();
    return promise;
  }

  function _registerSidebarSection(section: {
    id: string;
    title: string;
    items?: { id: string; label: string; active?: boolean }[];
  }): Promise<MutationResult> {
    if (!section || typeof section.id !== "string") {
      return Promise.resolve({ ok: false, error: "section.id required" });
    }
    const existing =
      ((state.extensionStateTree.sidebar as Record<string, unknown> | undefined)
        ?.extraSections as { id: string }[] | undefined) ?? [];
    const idx = existing.findIndex((s) => s.id === section.id);
    const next =
      idx >= 0
        ? existing.map((s, i) => (i === idx ? section : s))
        : [...existing, section];
    return setState(
      state,
      stateMutationDeps,
      "/sidebar/extraSections",
      next,
    );
  }

  function _registerTheme(theme: unknown): Promise<MutationResult> {
    const normalized = normalizeTheme(theme);
    if (!normalized) {
      const id = (theme as { id?: unknown } | null)?.id;
      const reserved =
        typeof id === "string" && RESERVED_THEME_IDS.has(id.trim());
      const errorMsg = reserved
        ? `registerTheme: id "${id}" is reserved (built-in theme)`
        : "registerTheme: theme requires {id, label?, vars}";
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    state.extensionThemes.set(normalized.id, normalized);
    const list = [...state.extensionThemes.values()];
    const { id, promise } = trackMutation(state);
    deps.send({ type: "extension_themes", mutationId: id, themes: list });
    deps.scheduleStateFileWrite();
    return promise;
  }

  function _registerHighlightGrammar(
    lang: unknown,
    grammar: unknown,
  ): Promise<MutationResult> {
    if (typeof lang !== "string" || lang.trim().length === 0) {
      const errorMsg =
        "registerHighlightGrammar: lang must be a non-empty string";
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    if (!grammar || typeof grammar !== "object") {
      const errorMsg =
        "registerHighlightGrammar: grammar must be a TextMate grammar object";
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const { id: mid, promise } = trackMutation(state);
    deps.send({
      type: "register_highlight_grammar",
      mutationId: mid,
      lang: lang.trim(),
      grammar,
    });
    return promise;
  }

  function _registerSlashCommand(cmd: unknown): Promise<MutationResult> {
    if (!cmd || typeof cmd !== "object") {
      return Promise.resolve({
        ok: false,
        error: "command requires { name }",
      });
    }
    const obj = cmd as { name?: unknown; description?: unknown; usage?: unknown };
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!/^[A-Za-z][\w-]*$/.test(name)) {
      const errorMsg =
        "registerSlashCommand: name must match /^[A-Za-z][\\w-]*$/";
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    if (BUILTIN_SLASH_NAMES.has(name)) {
      const errorMsg = `registerSlashCommand: "${name}" collides with a built-in command`;
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const description =
      typeof obj.description === "string" ? obj.description : "";
    const usage = typeof obj.usage === "string" ? obj.usage : undefined;
    state.extensionSlashCommands.set(name, {
      name,
      description,
      ...(usage ? { usage } : {}),
    });
    const list = [...state.extensionSlashCommands.values()];
    const { id, promise } = trackMutation(state);
    deps.send({
      type: "extension_slash_commands",
      mutationId: id,
      commands: list,
    });
    deps.scheduleStateFileWrite();
    return promise;
  }

  function _registerMenuItem(item: unknown): Promise<MutationResult> {
    if (!item || typeof item !== "object") {
      return Promise.resolve({ ok: false, error: "menu item required" });
    }
    const obj = item as {
      id?: unknown;
      label?: unknown;
      action?: unknown;
      location?: unknown;
      parent?: unknown;
    };
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    const action = typeof obj.action === "string" ? obj.action.trim() : "";
    if (!label || !action) {
      const errorMsg = "registerMenuItem: { label, action } required";
      deps.send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const id =
      typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : action;
    const location: "app" | "tray" =
      obj.location === "tray" ? "tray" : "app";
    const parent = typeof obj.parent === "string" ? obj.parent : undefined;
    state.extensionMenuItems.set(id, {
      id,
      label,
      action,
      location,
      ...(parent ? { parent } : {}),
    });
    const list = [...state.extensionMenuItems.values()];
    const { id: mid, promise } = trackMutation(state);
    deps.send({ type: "extension_menu_items", mutationId: mid, items: list });
    deps.scheduleStateFileWrite();
    return promise;
  }

  function _unregisterMenuItem(id: unknown): Promise<MutationResult> {
    if (typeof id !== "string" || !id.trim()) {
      return Promise.resolve({ ok: false, error: "id required" });
    }
    const had = state.extensionMenuItems.delete(id.trim());
    if (!had) return Promise.resolve({ ok: false, error: "no such id" });
    const list = [...state.extensionMenuItems.values()];
    const { id: mid, promise } = trackMutation(state);
    deps.send({ type: "extension_menu_items", mutationId: mid, items: list });
    deps.scheduleStateFileWrite();
    return promise;
  }

  function _onUnload(fn: () => void | Promise<void>): void {
    if (typeof fn !== "function") return;
    if (state.currentExtensionLoadScope === "project") {
      state.projectExtensionTeardowns.push(fn);
    } else {
      state.userExtensionTeardowns.push(fn);
    }
  }

  // -- shells.list/read/write --------------------------------------------
  async function _shellQuery(
    op: "list" | "read" | "write",
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<MutationResult> {
    if (!state.frontendReady) {
      // Bounded handshake wait — see shellQuery comment in original main.ts.
      const ready = await Promise.race<boolean>([
        state.frontendReadyPromise.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), MUTATION_ACK_TIMEOUT_MS_DEFAULT),
        ),
      ]);
      if (!ready) return { ok: false, error: "frontend_not_ready" };
    }
    const { id, promise } = trackMutation(state, timeoutMs);
    deps.send({ type: "shell_query", mutationId: id, op, args });
    return promise;
  }

  const shells: ShellsApi = {
    list: () => _shellQuery("list"),
    read: (input) => {
      if (!input || typeof input.tabId !== "string" || !input.tabId) {
        return Promise.resolve({ ok: false, error: "tabId required" });
      }
      return _shellQuery("read", {
        tabId: input.tabId,
        ...(typeof input.sinceTotal === "number"
          ? { sinceTotal: input.sinceTotal }
          : {}),
        ...(typeof input.maxBytes === "number"
          ? { maxBytes: input.maxBytes }
          : {}),
      });
    },
    write: (input) => {
      if (!input || typeof input.tabId !== "string" || !input.tabId) {
        return Promise.resolve({ ok: false, error: "tabId required" });
      }
      if (typeof input.text !== "string") {
        return Promise.resolve({ ok: false, error: "text must be a string" });
      }
      return _shellQuery(
        "write",
        { tabId: input.tabId, text: input.text },
        SHELL_WRITE_ACK_TIMEOUT_MS,
      );
    },
  };

  return {
    registerComponent: _registerComponent,
    setState: (path, value, sourceTabId) =>
      setState(state, stateMutationDeps, path, value, sourceTabId),
    onEvent: (match, handler) =>
      onEvent(state, eventDeps, match, handler),
    onUnload: _onUnload,
    setLayout: (payload) => setLayout(state, layoutDeps, payload),
    patchLayout: (path, value) => patchLayout(state, layoutDeps, path, value),
    registerSidebarSection: _registerSidebarSection,
    registerTheme: _registerTheme,
    registerHighlightGrammar: _registerHighlightGrammar,
    registerSlashCommand: _registerSlashCommand,
    registerLayout: (entry) => registerLayout(state, layoutDeps, entry),
    unregisterLayout: (id) => unregisterLayout(state, layoutDeps, id),
    listLayouts: () => listLayouts(state),
    registerKeybinding: (binding) =>
      registerKeybinding(state, keybindingsDeps, binding),
    unregisterKeybinding: (combo) =>
      unregisterKeybinding(state, keybindingsDeps, combo),
    registerMenuItem: _registerMenuItem,
    unregisterMenuItem: _unregisterMenuItem,
    notify: (input) => notify(state, notifDeps, input),
    dismissNotification: (id) => dismissNotification(state, notifDeps, id),
    registerEventRoute: (route) => registerEventRoute(state, eventDeps, route),
    unregisterEventRoute: (route) =>
      unregisterEventRoute(state, eventDeps, route),
    listEventRoutes: () => listEventRoutes(state),
    setEventRoutingMode: (mode) =>
      setEventRoutingMode(state, eventDeps, mode),
    listExtensions: () =>
      [...state.loadedExtensions.entries()].map(([name, source]) => ({
        name,
        source,
      })),
    listComponents: () => Object.fromEntries(state.extensionComponents),
    listThemes: () => [...state.extensionThemes.values()],
    getLayout: () => getLayout(state),
    getLayoutSlots: () => getLayoutSlots(state),
    getFrontendState: (path?: string) => {
      if (!path || typeof path !== "string") {
        return Object.fromEntries(state.frontendState);
      }
      return state.frontendState.has(path)
        ? state.frontendState.get(path)
        : undefined;
    },
    getRuntimeSnapshot: () => deps.getRuntimeSnapshot(),
    canvas: makeCanvasApi(state, stateMutationDeps, undefined),
    shells,
  };
}

/** Re-export for convenience — callers wiring keybindings often want
 *  the canonicalizer for diagnostic messages. */
export { canonicalizeCombo };
