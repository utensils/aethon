/**
 * Aethon agent bridge — JSON-lines over stdio between the Tauri shell and a
 * pi-coding-agent session.
 *
 * Inbound (stdin → bridge):
 *   { "type": "chat", "content": "..." }
 *   { "type": "set_model", "id": "provider/model-id" }
 *   { "type": "stop" }                          // abort the in-flight prompt
 *   { "type": "report" }                        // re-emit current ready state
 *                                               // (frontend uses this when the
 *                                               // webview reloads but bun is
 *                                               // already running)
 *   { "type": "a2ui_event", "event": { ... } }   // not yet wired into the agent
 *   { "type": "register_component", "componentType": "...", "template": {...} }
 *      // Register an A2UI subtree under a custom component type. When the
 *      // renderer encounters {type:"<componentType>"} it expands the
 *      // template in place. Templates may use `$ref` to bind to state.
 *   { "type": "set_state", "path": "/foo/bar", "value": <any> }
 *      // Mutate frontend layout state at the given JSON Pointer path.
 *      // Used by extensions to push live data (clocks, notifications) into
 *      // bound templates.
 *   { "type": "set_layout", "payload": {...} }
 *      // Replace the active A2UI layout wholesale. The same payload shape
 *      // the default-layout skill ships — A2UI tree + initial state.
 *      // Reaches the frontend as a `layout_set` event.
 *   { "type": "patch_layout", "path": "/components/0/children/2", "value": {...} }
 *      // Apply a JSON Pointer mutation to the active layout tree without
 *      // shipping a full replacement. Reaches the frontend as `layout_patch`.
 *   { "type": "register_theme", "theme": { id, label, vars } }
 *      // Register a color scheme. `vars` is a map of CSS custom properties
 *      // (keys must start with `--`); the frontend injects them into a
 *      // `:root[data-theme="<id>"]` rule and adds the theme to the sidebar.
 *
 * Outbound (bridge → stdout):
 *   { "type": "ready", "model": "<id>", "models": [{id,label,available}, ...],
 *     "extensionComponents": {<componentType>: <template>, ...},
 *     "extensionState": {<jsonPointer>: <value>, ...},
 *     "extensionThemes": [{id, label, vars}, ...] }
 *      // Snapshot of currently-registered extension templates AND the
 *      // most recent value at every path an extension pushed via setState,
 *      // sent on every ready emission so a webview reload picks them up
 *      // without losing state. extensionThemes ships the full theme list
 *      // so the frontend can rebuild its <style> tags + sidebar items.
 *   { "type": "extension_components", "components": {<componentType>: <template>, ...} }
 *      // Emitted after each registration delta; frontend hydrates templates
 *      // into the SkillRegistry.
 *   { "type": "state_patch", "path": "/foo", "value": <any> }
 *      // Forward of an extension's set_state call. Frontend applies via
 *      // JSON Pointer.
 *   { "type": "layout_set", "payload": {...} }
 *      // Replace the active A2UI layout. Frontend calls window.aethon.setLayout.
 *   { "type": "layout_patch", "path": "/foo", "value": <any> }
 *      // Patch a path inside the active layout payload via JSON Pointer.
 *   { "type": "extension_themes", "themes": [{id, label, vars}, ...] }
 *      // Emitted after each registerTheme call. The frontend rebuilds its
 *      // theme registry from the full list (no incremental delta).
 *   { "type": "notice", "message": "..." }
 *      // Non-terminal informational message. The frontend renders it as a
 *      // system chat bubble WITHOUT touching the waiting/status flags, so
 *      // an in-flight prompt stays in flight (Stop button stays visible).
 *   { "type": "response_delta", "messageId": "<msg-id>", "content": "..." }
 *      // messageId groups deltas that belong to the same pi assistant message
 *      // (timestamp-derived). The frontend uses it to keep all text from one
 *      // message in a single bubble even when tool cards land in between.
 *   { "type": "response_end" }
 *   { "type": "a2ui", "id": "<message-id>", "payload": { ... } }
 *      // Used for tool execution cards. Frontend treats `id` as a stable
 *      // chat-message identity — re-emitting the same id replaces in place
 *      // (so we can stream "running…" → final result).
 *   { "type": "model_changed", "model": "<id>" }
 *   { "type": "error", "message": "..." }
 *
 * Model + provider come from pi's settings (~/.pi/agent/settings.json) — the
 * default model is `defaultModel` and the picker lists every model returned
 * by ModelRegistry.getAll(), with `available: true` on the ones whose
 * provider has credentials configured.
 */

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createInterface } from "node:readline";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolveAethonSystemPrompt } from "./system-prompt";

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function modelKey(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
}

// Decode a JSON Pointer token (RFC 6901). `~1` → `/`, `~0` → `~`.
function decodePointerToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}

// Apply value at JSON Pointer path inside an immutable tree. Mirror of the
// frontend's setPointer so the bridge can keep extensionStateTree in sync
// with what the frontend computes from the same patches.
function setAtPointer(
  state: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  if (!pointer || pointer === "" || pointer === "/") return state;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodePointerToken);
  const next: Record<string, unknown> = { ...state };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const existing = cursor[key];
    const child =
      typeof existing === "object" && existing !== null
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cursor[key] = child;
    cursor = child;
  }
  cursor[tokens[tokens.length - 1]] = value;
  return next;
}

// Layout-aware patch that preserves arrays (mirror of the frontend's
// layoutPatch). Used to fold patch_layout calls into the retained
// layout so ready/report replay matches the live frontend state.
function patchLayoutTree(
  payload: unknown,
  pointer: string,
  value: unknown,
): unknown {
  if (!pointer || pointer === "" || pointer === "/") return payload;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodePointerToken);
  const cloneNode = (node: unknown): Record<string, unknown> | unknown[] => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === "object") {
      return { ...(node as Record<string, unknown>) };
    }
    return {};
  };
  const root = cloneNode(payload);
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const idx = Array.isArray(cursor) ? Number(key) : key;
    const existing = (cursor as Record<string | number, unknown>)[idx as never];
    const child = cloneNode(existing);
    (cursor as Record<string | number, unknown>)[idx as never] = child;
    cursor = child;
  }
  const lastKey = tokens[tokens.length - 1];
  const lastIdx = Array.isArray(cursor) ? Number(lastKey) : lastKey;
  (cursor as Record<string | number, unknown>)[lastIdx as never] = value;
  return root;
}

function modelDescriptor(m: Model<Api>) {
  return {
    id: modelKey(m),
    label: m.name ?? m.id,
    provider: m.provider,
  };
}

// Compile a pi-style enabledModels glob ("anthropic/claude-*") into a RegExp
// rooted at the model key. Only `*` is treated as a wildcard (matches any
// chars except `/`); everything else is escaped literally.
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWild = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${withWild}$`);
}

// Render a one-line summary of tool args so the card description shows what
// the tool was actually invoked with, not just `{...}`. Pi's built-in tools
// have stable arg shapes; unknown tools fall back to a JSON preview.
function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "read":
      return [a.path, a.startLine && `lines ${a.startLine}-${a.endLine ?? "end"}`]
        .filter(Boolean)
        .join(" ");
    case "bash":
      return String(a.command ?? "").split("\n")[0]?.slice(0, 200) ?? "";
    case "edit":
    case "write":
      return String(a.path ?? "");
    case "grep":
      return `${a.pattern ?? ""}${a.path ? ` in ${a.path}` : ""}`;
    case "find":
      return String(a.pattern ?? a.path ?? "");
    case "ls":
      return String(a.path ?? ".");
    default: {
      const json = JSON.stringify(args);
      return json.length > 200 ? json.slice(0, 197) + "…" : json;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

type ExtractedImage = { data: string; mimeType: string };
type ExtractedResult = { text: string; images: ExtractedImage[] };

// Cap images per tool card so a screenshot-spamming tool can't bloat a single
// chat message past localStorage / IPC sanity limits.
const MAX_IMAGES_PER_RESULT = 4;

// Pi tool results follow the shape `{ content: [{type:"text", text:"..."}, ...] }`
// (matching the LLM provider tool-result content format). Walk the content
// array, pull out text for the code-block child and image data for any
// `image` primitives we render alongside it.
function extractToolContent(result: unknown): ExtractedResult {
  const empty: ExtractedResult = { text: "", images: [] };
  if (result === null || result === undefined) return empty;
  if (typeof result === "string") return { text: result, images: [] };
  if (typeof result !== "object") {
    return { text: String(result), images: [] };
  }

  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const texts: string[] = [];
    const images: ExtractedImage[] = [];
    for (const p of obj.content) {
      if (!p || typeof p !== "object") continue;
      const part = p as { type?: string; text?: string; data?: string; mimeType?: string };
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      } else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        if (images.length < MAX_IMAGES_PER_RESULT) {
          images.push({ data: part.data, mimeType: part.mimeType });
        }
      }
    }
    if (texts.length > 0 || images.length > 0) {
      return { text: texts.join("\n"), images };
    }
  }
  if (typeof obj.text === "string") return { text: obj.text, images: [] };
  try {
    return { text: JSON.stringify(result, null, 2), images: [] };
  } catch {
    return { text: String(result), images: [] };
  }
}

// Build the A2UI payload for a tool-call card. `running` controls the title
// suffix; `result` (when present) renders as a fenced code block plus any
// image children extracted from the tool result content.
function toolCardPayload(opts: {
  callId: string;
  toolName: string;
  argsSummary: string;
  result?: unknown;
  isError?: boolean;
  running?: boolean;
}) {
  const { callId, toolName, argsSummary, result, isError, running } = opts;
  const titleSuffix = running ? " · running…" : isError ? " · error" : "";
  const children: unknown[] = [];
  if (result !== undefined) {
    const extracted = extractToolContent(result);
    if (extracted.text) {
      children.push({
        id: `tool-${callId}-result`,
        type: "code",
        props: {
          content: truncate(extracted.text, 1500),
          language: "text",
        },
      });
    }
    extracted.images.forEach((img, i) => {
      children.push({
        id: `tool-${callId}-image-${i}`,
        type: "image",
        props: {
          src: `data:${img.mimeType};base64,${img.data}`,
          alt: `${toolName} image ${i + 1}`,
        },
      });
    });
  }
  return {
    components: [
      {
        id: `tool-${callId}`,
        type: "card",
        props: {
          title: `${toolName}${titleSuffix}`,
          description: argsSummary || undefined,
        },
        children,
      },
    ],
  };
}

interface AethonExtensionApi {
  registerComponent(componentType: string, template: unknown): void;
  setState(path: string, value: unknown): void;
  registerTheme?: (theme: unknown) => void;
}

interface ThemeRecord {
  id: string;
  label: string;
  vars: Record<string, string>;
}

// Theme ids the frontend ships built-in CSS for (see src/styles.css).
// Extensions can't reuse these — the frontend always seeds the sidebar
// with these labels and the rule comes from the static stylesheet, so
// shadowing would either show a duplicate item or silently override
// the built-in palette. The bridge rejects collisions here.
const RESERVED_THEME_IDS = new Set(["dark", "light"]);

// Validate theme metadata. The id is constrained to a slug so it's safe
// to embed in a CSS selector and a <style> element id; the variable
// names must look like CSS custom properties (`--*`). Variable values
// are passed through as-is — the frontend writes them via CSSOM
// `setProperty`, which silently rejects anything that would escape
// the declaration. Returns null when the input is too malformed to use
// (or collides with a reserved built-in id).
function normalizeTheme(input: unknown): ThemeRecord | null {
  if (!input || typeof input !== "object") return null;
  const t = input as { id?: unknown; label?: unknown; vars?: unknown };
  const id = typeof t.id === "string" ? t.id.trim() : "";
  if (!/^[A-Za-z][\w-]*$/.test(id)) return null;
  if (RESERVED_THEME_IDS.has(id)) return null;
  const label = typeof t.label === "string" && t.label.trim().length > 0
    ? t.label.trim()
    : id;
  const vars: Record<string, string> = {};
  if (t.vars && typeof t.vars === "object") {
    for (const [k, v] of Object.entries(t.vars as Record<string, unknown>)) {
      if (!/^--[A-Za-z0-9_-]+$/.test(k)) continue;
      if (typeof v !== "string") continue;
      vars[k] = v;
    }
  }
  return { id, label, vars };
}

interface AethonExtensionModule {
  register?: (api: AethonExtensionApi) => void | Promise<void>;
  default?: { register?: (api: AethonExtensionApi) => void | Promise<void> };
}

// Discover and load Aethon extensions from ~/.aethon/extensions/*.{ts,js}.
// Each extension exports `register(api)` (named or as default.register).
// Bun executes .ts directly so authors don't need a build step.
async function loadAethonExtensions(api: AethonExtensionApi): Promise<void> {
  const dir = join(homedir(), ".aethon", "extensions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // Missing dir is the common case — extensions are optional.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-ext] readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  for (const name of entries) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const mod: AethonExtensionModule = await import(pathToFileURL(file).href);
      const register = mod.register ?? mod.default?.register;
      if (typeof register !== "function") {
        console.error(`[aethon-ext] ${name}: no register() export, skipping`);
        continue;
      }
      await register(api);
      console.error(`[aethon-ext] loaded ${name}`);
    } catch (err) {
      console.error(`[aethon-ext] ${name}: ${(err as Error).message}`);
    }
  }
}

async function main() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(process.cwd());

  // Tab whose pi turn is currently running. Set when a chat / handler
  // prompt is dispatched; cleared on agent_end. Used by _setState so
  // direct globalThis.aethon.setState calls from the agent or extensions
  // reacting to agent events get attributed to the right tab even
  // though the API itself takes no tabId argument.
  //
  // Hoisted to the top of main() so _setState's reference doesn't TDZ
  // when an extension calls aethon.setState during resourceLoader.reload()
  // — extensions that initialize UI state at load time would otherwise
  // crash agent startup with a ReferenceError.
  //
  // Concurrent prompts across tabs would race this — pi's followUp
  // queue serializes within a tab, but a handler could fire
  // ctx.pi.prompt on tab A while a chat is processing on tab B.
  // For now we track only the most recent prompt's tab; multi-tab
  // concurrency is an acknowledged sharp edge.
  let currentAgentTabId: string | undefined;

  // Build the Aethon extension API and attach it to globalThis BEFORE
  // createAgentSession runs, because pi loads extensions inside that call.
  // Without this ordering, pi extensions that try to call
  // `globalThis.aethon.registerComponent(...)` see `undefined` and silently
  // no-op. The state maps below close over the same references the rest of
  // the bridge uses, so the extension API stays in sync with the registry.
  const extensionComponents = new Map<string, unknown>();
  // Themes registered by extensions, keyed by id. Insertion order is
  // preserved on iteration so the sidebar shows them in registration order.
  const extensionThemes = new Map<string, ThemeRecord>();
  let extensionStateTree: Record<string, unknown> = {};
  // Latest extension-supplied layout (set by setLayout, mutated by
  // patchLayout). Retained so a webview reload's `report` → `ready`
  // re-emits it instead of falling back to the boot layout. `undefined`
  // means no extension has overridden the default layout.
  let extensionLayout: unknown = undefined;
  // Patches applied via patchLayout when no extensionLayout has been set
  // yet — they target the default layout. Retained as an ordered list
  // so reload-replay applies them in the same sequence the live frontend
  // received them. Cleared whenever setLayout is called (the new layout
  // replaces everything those patches were targeting).
  let pendingLayoutPatches: { path: string; value: unknown }[] = [];

  // Handlers registered by extensions for a2ui_event messages from the
  // frontend. Each entry's `match` predicates filter which events the
  // handler runs on; a missing predicate matches any. Handlers can call
  // ctx.setState/registerComponent in response to drive UI updates.
  interface A2UIEventMatch {
    templateRootType?: string;
    componentType?: string;
    descendantId?: string;
    eventType?: string;
  }
  interface A2UIEventInfo {
    componentId?: string;
    componentType?: string;
    templateRootType?: string;
    eventType?: string;
    data?: unknown;
  }
  // ctx.pi is a thin facade over pi-coding-agent's AgentSession scoped to
  // what makes sense for an A2UI event handler. Following pi's convention,
  // it's typed and intentionally narrow — handlers shouldn't need pi's
  // full ExtensionContext and shouldn't be able to mutate pi's session
  // state directly. Adding methods here is a deliberate choice: they
  // become the contract for every UI handler in the ecosystem.
  interface PiHandlerCtx {
    /** Fire an LLM turn from the handler. The chat input UI updates the
     *  same way it would for a user-typed message. Use this to wire
     *  buttons / sidebar items to agent actions ("summarize git log",
     *  "explain this file"). Rejects if a prompt is already in flight. */
    prompt(text: string): Promise<void>;
    /** Push a system message into the chat history. Non-terminal — does
     *  not toggle waiting/Stop. Use for handler progress notes. */
    notify(message: string): void;
    /** Read-only session info: current model id and last 50 messages. */
    readonly session: {
      readonly model: string;
      readonly messages: ReadonlyArray<unknown>;
    };
    /** AbortSignal that fires when the user presses Stop or a new chat
     *  comes in. Pass to fetch / spawn / model calls so handler work
     *  cancels with the rest of the turn. Undefined when the handler
     *  fires outside an agent turn (most sidebar clicks). */
    readonly signal: AbortSignal | undefined;
  }
  type A2UIEventHandler = (
    event: A2UIEventInfo,
    ctx: {
      setState: AethonApi["setState"];
      registerComponent: AethonApi["registerComponent"];
      pi: PiHandlerCtx;
    },
  ) => void | Promise<void>;
  const a2uiEventHandlers: { match: A2UIEventMatch; handler: A2UIEventHandler }[] = [];

  // Plain functions so methods can call each other without `this` binding
  // ambiguity (extensions sometimes destructure: `const { setState } = aethon`).
  function _registerComponent(componentType: string, template: unknown): void {
    if (!componentType || typeof componentType !== "string") return;
    extensionComponents.set(componentType, template);
    send({
      type: "extension_components",
      components: Object.fromEntries(extensionComponents),
    });
  }
  function _setState(path: string, value: unknown, sourceTabId?: string): void {
    if (!path || typeof path !== "string") return;
    // tabId attribution priority:
    //   1. explicit sourceTabId (handler-scoped ctx.setState)
    //   2. currentAgentTabId — set while a tab's pi.prompt is in flight,
    //      so direct globalThis.aethon.setState calls from the agent /
    //      from extensions reacting to agent events route to the tab
    //      whose turn is running.
    //   3. omit tabId — frontend falls back to active. Last resort for
    //      truly tab-less setStates (e.g. a clock interval fired with
    //      no agent turn).
    const attributedTab = sourceTabId ?? currentAgentTabId;
    // Per-tab mirrored writes (canvas / messages / draft / waiting /
    // queueCount / model) DON'T belong in the global extensionStateTree
    // — that gets replayed wholesale on `ready` and would smear one
    // tab's state across whichever tab is active after the reload.
    // Keep them off the global tree; the frontend stores them on the
    // tab record (which survives reload via React state).
    const segs = path.split("/").filter(Boolean);
    const top = segs[0];
    const isMirroredPerTab =
      attributedTab !== undefined &&
      (top === "messages" || top === "draft" || top === "waiting" ||
       top === "queueCount" || top === "canvas" || top === "model");
    if (!isMirroredPerTab) {
      extensionStateTree = setAtPointer(extensionStateTree, path, value);
    }
    send({
      type: "state_patch",
      path,
      value,
      ...(attributedTab ? { tabId: attributedTab } : {}),
    });
  }
  function _onEvent(match: A2UIEventMatch, handler: A2UIEventHandler): void {
    if (typeof handler !== "function") return;
    a2uiEventHandlers.push({ match, handler });
  }
  function _setLayout(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    extensionLayout = payload;
    // The new layout replaces whatever the pending patches were
    // targeting — drop them so they don't replay against the new tree.
    pendingLayoutPatches = [];
    send({ type: "layout_set", payload });
  }
  function _patchLayout(path: string, value: unknown): void {
    if (!path || typeof path !== "string") return;
    // Apply into the retained extension layout if there is one; otherwise
    // queue against the default layout so reload-replay still applies
    // it. The live frontend gets the same `layout_patch` event either
    // way and folds it via its own array-preserving patcher.
    if (extensionLayout) {
      extensionLayout = patchLayoutTree(extensionLayout, path, value);
    } else {
      pendingLayoutPatches.push({ path, value });
    }
    send({ type: "layout_patch", path, value });
  }
  function _registerSidebarSection(section: {
    id: string;
    title: string;
    items?: { id: string; label: string; active?: boolean }[];
  }): void {
    if (!section || typeof section.id !== "string") return;
    const existing =
      ((extensionStateTree.sidebar as Record<string, unknown> | undefined)
        ?.extraSections as { id: string }[] | undefined) ?? [];
    const idx = existing.findIndex((s) => s.id === section.id);
    const next = idx >= 0
      ? existing.map((s, i) => (i === idx ? section : s))
      : [...existing, section];
    _setState("/sidebar/extraSections", next);
  }
  // Register a color scheme. Extension-side, the contract is "give me an
  // id, a label, and a CSS-variable map" — the bridge sanitizes it (see
  // normalizeTheme) and emits a delta. The frontend rebuilds <style> tags
  // from the full list and appends id/label entries to /sidebar/themes
  // alongside the built-in dark/light items.
  function _registerTheme(theme: unknown): void {
    const normalized = normalizeTheme(theme);
    if (!normalized) {
      const id = (theme as { id?: unknown } | null)?.id;
      const reserved =
        typeof id === "string" && RESERVED_THEME_IDS.has(id.trim());
      send({
        type: "error",
        message: reserved
          ? `registerTheme: id "${id}" is reserved (built-in theme)`
          : "registerTheme: theme requires {id, label?, vars}",
      });
      return;
    }
    extensionThemes.set(normalized.id, normalized);
    const list = [...extensionThemes.values()];
    send({ type: "extension_themes", themes: list });
  }

  const aethonApi = {
    registerComponent: _registerComponent,
    setState: _setState,
    onEvent: _onEvent,
    setLayout: _setLayout,
    patchLayout: _patchLayout,
    registerSidebarSection: _registerSidebarSection,
    registerTheme: _registerTheme,
  };
  type AethonApi = typeof aethonApi;
  (globalThis as { aethon?: AethonApi }).aethon = aethonApi;

  // Inject Aethon-awareness into pi's system prompt so the model knows it
  // has a GUI and can mutate `globalThis.aethon` directly. Goes through the
  // resource loader's appendSystemPromptOverride callback (NOT the
  // appendSystemPrompt source) so the user's existing project / global
  // APPEND_SYSTEM.md files are still discovered and preserved — our text
  // is concatenated AFTER theirs so user instructions take precedence.
  // agentDir comes from pi's getAgentDir() so PI_CODING_AGENT_DIR /
  // alternate config dirs work the same way they do for the rest of pi.
  const aethonAppend = resolveAethonSystemPrompt();
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, ...aethonAppend],
  });
  await resourceLoader.reload();

  // ---------------------------------------------------------------------
  // Multi-tab session model. Each tab owns its own pi AgentSession and the
  // per-turn state machine that wraps it (in-flight tracking, queue count,
  // tool args cache for end-state cards). Sessions share authStorage,
  // modelRegistry, settingsManager, and resourceLoader so they all see the
  // same models and extension surface — only message history and active
  // turn are isolated.
  //
  // Tabs are created lazily on first inbound message for a tabId. The
  // frontend always sends tabId; legacy callers without it default to
  // "default". Closing a tab aborts its in-flight prompt and drops the
  // session reference; pi reclaims the in-memory history with the GC.
  // ---------------------------------------------------------------------
  interface TabRecord {
    id: string;
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    toolArgsCache: Map<string, { name: string; summary: string }>;
    promptInFlight: boolean;
    agentEndFired: boolean;
    queuedCount: number;
  }

  const tabs = new Map<string, TabRecord>();

  // Filter the picker to the user's enabledModels patterns from
  // ~/.pi/agent/settings.json. Patterns may include `*` wildcards
  // (e.g., "anthropic/claude-*"). When no patterns are configured,
  // fall back to authed models so the picker is never empty.
  // Computed once — the picker is global, not per-tab.
  function buildPickerModels(currentModel?: Model<Api>): Model<Api>[] {
    const all = modelRegistry.getAll();
    const enabled = settingsManager.getEnabledModels();
    let pickerModels: Model<Api>[];
    if (enabled && enabled.length > 0) {
      const patterns = enabled.map(compilePattern);
      pickerModels = all.filter((m) => patterns.some((p) => p.test(modelKey(m))));
    } else {
      pickerModels = modelRegistry.getAvailable();
    }
    // Always include the current session model so the active model is
    // selectable even if its provider isn't authed or matched.
    const seen = new Set(pickerModels.map(modelKey));
    if (currentModel && !seen.has(modelKey(currentModel))) {
      pickerModels.unshift(currentModel);
    }
    return pickerModels;
  }

  // Cache the picker so emitReady doesn't recompute on every report.
  // First populated when the default tab is created.
  let cachedModels: ReturnType<typeof modelDescriptor>[] = [];

  function defaultModelKey(): string {
    const def = tabs.get("default");
    return def?.session.model ? modelKey(def.session.model) : "";
  }

  function emitReady() {
    send({
      type: "ready",
      model: defaultModelKey(),
      models: cachedModels,
      tabs: [...tabs.values()].map((t) => ({
        id: t.id,
        model: t.session.model ? modelKey(t.session.model) : "",
      })),
      extensionComponents: Object.fromEntries(extensionComponents),
      extensionState: extensionStateTree,
      extensionLayout,
      extensionLayoutPatches: pendingLayoutPatches,
      extensionThemes: [...extensionThemes.values()],
    });
  }

  // Format and forward bash output to the terminal panel in chunks. Caps a
  // single emit at TERMINAL_MAX_BYTES (trailing window) so a sudden burst
  // can't choke the IPC pipe. Now per-tab — the frontend buffers each tab
  // independently and only renders the active tab's stream.
  const TERMINAL_MAX_BYTES = 64 * 1024;
  const TERMINAL_CHUNK_BYTES = 8 * 1024;

  function emitBashResult(text: string, tabId: string): void {
    if (!text) return;
    let body = text;
    let truncated = false;
    if (body.length > TERMINAL_MAX_BYTES) {
      body = body.slice(body.length - TERMINAL_MAX_BYTES);
      truncated = true;
    }
    if (truncated) {
      send({
        type: "terminal_output",
        tabId,
        content: `\r\n[…output truncated to last ${TERMINAL_MAX_BYTES} bytes]\r\n`,
      });
    }
    const normalized = body.replace(/\r?\n/g, "\r\n");
    for (let i = 0; i < normalized.length; i += TERMINAL_CHUNK_BYTES) {
      send({
        type: "terminal_output",
        tabId,
        content: normalized.slice(i, i + TERMINAL_CHUNK_BYTES),
      });
    }
  }

  // Create (or fetch) the session record for a tabId. Subscribes to its
  // pi session and tags every per-turn event with tabId so the frontend
  // routes deltas / tool cards / response_end to the right tab. The first
  // call also seeds cachedModels — the picker is global but its content
  // depends on a session having been spun up so we know the current
  // model defaults.
  //
  // initialModel lets the caller create the session with a specific model
  // already selected, avoiding a tab_open → set_model round-trip race
  // where a fast first prompt could land before the model switch.
  async function ensureTab(
    tabId: string,
    initialModel?: Model<Api>,
  ): Promise<TabRecord> {
    const existing = tabs.get(tabId);
    if (existing) return existing;

    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
      ...(initialModel ? { model: initialModel } : {}),
    });

    const rec: TabRecord = {
      id: tabId,
      session,
      toolArgsCache: new Map(),
      promptInFlight: false,
      agentEndFired: false,
      queuedCount: 0,
    };
    tabs.set(tabId, rec);

    // First tab: populate the global picker now that we have a model.
    if (cachedModels.length === 0) {
      cachedModels = buildPickerModels(session.model).map(modelDescriptor);
    }

    // Per-tab subscriber. Closes over rec so increments / clears stay
    // local; closes over tabId so outbound events carry routing.
    session.subscribe((event) => {
      switch (event.type) {
        case "agent_start": {
          // Each turn (initial or queue-drained) is owned by this tab —
          // set currentAgentTabId so any setStates the agent triggers
          // route correctly. Cleared in agent_end below.
          currentAgentTabId = tabId;
          if (rec.queuedCount > 0) {
            rec.queuedCount -= 1;
            // The previous agent_end cleared promptInFlight, but pi has
            // already started the queue-drained turn — re-mark in-flight
            // so a follow-up chat / set_model on this tab queues correctly
            // instead of being treated as a fresh idle prompt.
            rec.promptInFlight = true;
            rec.agentEndFired = false;
            send({ type: "prompt_started", tabId, source: "queue", queued: rec.queuedCount });
          }
          break;
        }
        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta ?? "";
            if (delta) {
              const ts = (event.message as { timestamp?: number } | undefined)?.timestamp ?? 0;
              const messageId = `text-${ts}`;
              send({ type: "response_delta", tabId, messageId, content: delta });
            }
          }
          break;
        }
        case "tool_execution_start": {
          const summary = summarizeToolArgs(event.toolName, event.args);
          rec.toolArgsCache.set(event.toolCallId, { name: event.toolName, summary });
          const payload = toolCardPayload({
            callId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: summary,
            running: true,
          });
          send({ type: "a2ui", tabId, id: `tool-${event.toolCallId}`, payload });
          if (event.toolName === "bash") {
            const cmd = String((event.args as { command?: unknown } | undefined)?.command ?? "");
            const echoed = cmd.replace(/\r?\n/g, "\r\n");
            send({ type: "terminal_output", tabId, content: `\r\n$ ${echoed}\r\n` });
          }
          break;
        }
        case "tool_execution_end": {
          const cached = rec.toolArgsCache.get(event.toolCallId);
          const payload = toolCardPayload({
            callId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: cached?.summary ?? "",
            result: event.result,
            isError: event.isError,
          });
          send({ type: "a2ui", tabId, id: `tool-${event.toolCallId}`, payload });
          if (event.toolName === "bash") {
            const extracted = extractToolContent(event.result);
            emitBashResult(extracted.text, tabId);
            send({ type: "terminal_output", tabId, content: "\r\n" });
          }
          rec.toolArgsCache.delete(event.toolCallId);
          break;
        }
        case "agent_end": {
          rec.agentEndFired = true;
          rec.promptInFlight = false;
          if (currentAgentTabId === tabId) currentAgentTabId = undefined;
          send({ type: "response_end", tabId });
          break;
        }
      }
    });

    // Tell the frontend a new tab is ready so it can show the model it
    // defaulted to (relevant for tabs created server-side or via "duplicate").
    send({
      type: "tab_ready",
      tabId,
      model: session.model ? modelKey(session.model) : "",
    });

    return rec;
  }

  // Pre-create the default tab so emitReady has a populated cachedModels
  // and the frontend can start dispatching to "default" without first
  // racing an ensureTab call.
  await ensureTab("default");

  // Discover Aethon-only extensions in `~/.aethon/extensions/*.ts` and call
  // their `register(api)` default export. (Pi extensions reach the same API
  // via `globalThis.aethon` — set above before createAgentSession.)
  // Failures in one extension don't block others.
  await loadAethonExtensions(aethonApi);

  emitReady();

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: {
      type: string;
      content?: string;
      id?: string;
      tabId?: string;
      componentType?: string;
      template?: unknown;
      path?: string;
      value?: unknown;
      payload?: unknown;
      theme?: unknown;
      event?: {
        componentId?: string;
        componentType?: string;
        templateRootType?: string;
        eventType?: string;
        data?: unknown;
      };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ type: "error", message: "invalid JSON" });
      continue;
    }

    try {
      switch (msg.type) {
        case "chat": {
          if (!msg.content) {
            send({ type: "error", message: "chat: missing content" });
            break;
          }
          // tabId routes the prompt to the right session. Frontend always
          // sends one; legacy callers without it default to "default".
          const tabId = msg.tabId ?? "default";
          const tab = await ensureTab(tabId);
          // CRITICAL: do NOT await — `for await (const line of rl)` processes
          // one stdin line at a time, so awaiting here would queue any
          // subsequent "stop" message behind the in-flight prompt and Stop
          // would never reach session.abort() until the prompt finished
          // naturally. Track in-flight state on the tab record.
          //
          // When a prompt is already running on this tab, pass
          // `streamingBehavior: "followUp"` so pi appends the new message
          // to its internal queue and processes it after the current turn
          // settles. We DON'T flip promptInFlight for queued ones —
          // agent_end fires per turn and pi automatically drains the queue.
          const queued = tab.promptInFlight;
          if (!queued) {
            tab.promptInFlight = true;
            tab.agentEndFired = false;
          } else {
            tab.queuedCount += 1;
          }
          if (!queued) currentAgentTabId = tabId;
          tab.session
            .prompt(msg.content, queued ? { streamingBehavior: "followUp" } : undefined)
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              send({ type: "error", tabId, message: `prompt: ${message}` });
            })
            .finally(() => {
              if (!queued && !tab.agentEndFired) {
                tab.promptInFlight = false;
                send({ type: "response_end", tabId });
              }
              if (!queued && currentAgentTabId === tabId) {
                currentAgentTabId = undefined;
              }
            });
          if (queued) {
            send({ type: "queued", tabId });
          }
          break;
        }
        case "set_model": {
          if (!msg.id) {
            send({ type: "error", message: "set_model: missing id" });
            break;
          }
          // Lazily create the session if the user hits set_model on a brand
          // new tab before the async tab_open round-trip finishes — the
          // chat / a2ui_event paths already do this; mirror the behavior
          // here so fast switches don't fail with "unknown tab".
          const tabId = msg.tabId ?? "default";
          const tab = await ensureTab(tabId);
          // Same in-flight gate as `chat`: pi rejects setModel while a run
          // is active, and the resulting `error` would clobber waiting=true
          // and hide the Stop button on the original prompt. Surface as a
          // non-terminal notice instead so the user keeps their stop UI.
          if (tab.promptInFlight) {
            send({
              type: "notice",
              tabId,
              message: "agent busy — stop the current prompt before switching models",
            });
            break;
          }
          const [provider, ...rest] = msg.id.split("/");
          const id = rest.join("/");
          const next = modelRegistry.find(provider, id);
          if (!next) {
            send({ type: "error", tabId, message: `set_model: unknown model ${msg.id}` });
            break;
          }
          await tab.session.setModel(next);
          send({ type: "model_changed", tabId, model: msg.id });
          break;
        }
        case "stop": {
          // session.abort() cancels the LLM stream / agent loop. The agent's
          // run signal propagates to the bash tool's `signal.addEventListener
          // ("abort", ...)` handler, which calls killProcessTree(child.pid),
          // so any in-flight bash subprocess gets SIGKILLed. Don't await —
          // we want to free the message loop immediately so a follow-up
          // chat doesn't queue behind a slow settle.
          const tabId = msg.tabId ?? "default";
          const tab = tabs.get(tabId);
          if (!tab) break; // nothing to stop on a tab we never spun up
          tab.session.abort().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            send({ type: "error", tabId, message: `abort: ${message}` });
          });
          break;
        }
        case "tab_open": {
          // Explicit tab create. Returns immediately if the tab already
          // exists — useful for the frontend to pre-warm a tab before the
          // user types into it. Emits `tab_ready` with the new model.
          //
          // Optional `model` (provider/id) sets the session's initial
          // model so a fast first chat doesn't race the inherited
          // set_model round-trip.
          const tabId = msg.tabId;
          if (!tabId || typeof tabId !== "string") {
            send({ type: "error", message: "tab_open: missing tabId" });
            break;
          }
          const modelId = (msg as { model?: unknown }).model;
          let initialModel: Model<Api> | undefined;
          if (typeof modelId === "string" && modelId.length > 0) {
            const [provider, ...rest] = modelId.split("/");
            initialModel = modelRegistry.find(provider, rest.join("/")) ?? undefined;
          }
          await ensureTab(tabId, initialModel);
          break;
        }
        case "tab_close": {
          // Tear down a tab's session. Aborts any in-flight prompt first
          // so kill signals propagate before we drop the reference. The
          // "default" tab can't be closed — there must always be one.
          const tabId = msg.tabId;
          if (!tabId || typeof tabId !== "string") {
            send({ type: "error", message: "tab_close: missing tabId" });
            break;
          }
          if (tabId === "default") {
            send({ type: "notice", message: "cannot close the default tab" });
            break;
          }
          const tab = tabs.get(tabId);
          if (!tab) break;
          if (tab.promptInFlight) {
            tab.session.abort().catch(() => {
              /* fire-and-forget — we're tearing down anyway */
            });
          }
          tabs.delete(tabId);
          send({ type: "tab_closed", tabId });
          break;
        }
        case "report": {
          emitReady();
          break;
        }
        case "a2ui_event": {
          const ev = msg.event ?? {};
          // descendantId is the part of componentId after the template
          // expansion marker `__tpl__` — extracted here so handlers can
          // match on a logical descendant id without parsing themselves.
          const descendantId = ev.componentId?.includes("__tpl__")
            ? ev.componentId.split("__tpl__").slice(1).join("__tpl__")
            : undefined;
          // a2ui events from the active tab; default routes to "default"
          // for back-compat. Handlers run against this tab's session, so
          // ctx.pi.prompt() opens a turn on the same tab the user clicked
          // from — not whichever tab pi was last touched on.
          const handlerTabId = msg.tabId ?? "default";
          const handlerTab = await ensureTab(handlerTabId);
          // Build the ctx.pi facade fresh per dispatch so handlers always
          // see the current session model + last 50 messages.
          const piCtx: PiHandlerCtx = {
            async prompt(text: string) {
              if (!text || typeof text !== "string") return;
              if (handlerTab.promptInFlight) {
                send({
                  type: "notice",
                  tabId: handlerTabId,
                  message: "agent busy — handler prompt rejected",
                });
                throw new Error("agent busy — prompt in flight");
              }
              handlerTab.promptInFlight = true;
              handlerTab.agentEndFired = false;
              currentAgentTabId = handlerTabId;
              // Tell the frontend a turn is starting so it can flip
              // waiting=true (Stop button visible, chat input disabled).
              send({ type: "prompt_started", tabId: handlerTabId, source: "handler" });
              try {
                await handlerTab.session.prompt(text);
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                send({ type: "error", tabId: handlerTabId, message: `handler prompt: ${m}` });
                throw err;
              } finally {
                if (!handlerTab.agentEndFired) {
                  handlerTab.promptInFlight = false;
                  send({ type: "response_end", tabId: handlerTabId });
                }
                if (currentAgentTabId === handlerTabId) {
                  currentAgentTabId = undefined;
                }
              }
            },
            notify(message: string) {
              if (!message) return;
              send({ type: "notice", tabId: handlerTabId, message });
            },
            get session() {
              const messages = handlerTab.session.messages ?? [];
              return {
                model: handlerTab.session.model ? modelKey(handlerTab.session.model) : "",
                messages: messages.slice(-50),
              };
            },
            // Pi's active-turn AbortSignal lives on `session.agent.signal`
            // (verified via @mariozechner/pi-agent-core agent.d.ts:90).
            get signal() {
              return handlerTab.session.agent?.signal;
            },
          };
          // Tab-scoped setState for handlers: writes carry the originating
          // tabId so the frontend can route mirrored-key patches back to
          // the right tab even when the user has since switched.
          const tabScopedSetState = (path: string, value: unknown) =>
            _setState(path, value, handlerTabId);
          for (const { match, handler } of a2uiEventHandlers) {
            if (match.templateRootType && match.templateRootType !== ev.templateRootType) continue;
            if (match.componentType && match.componentType !== ev.componentType) continue;
            if (match.eventType && match.eventType !== ev.eventType) continue;
            if (match.descendantId && match.descendantId !== descendantId) continue;
            // Fire-and-forget the handler: do NOT await it inside the
            // stdin loop. If a handler awaits `ctx.pi.prompt(...)` (the
            // documented pattern for chaining "prompt → render result"),
            // awaiting here would keep the bridge pinned in this case
            // until the agent turn settles — meaning a follow-up Stop
            // command would queue behind it and never reach
            // session.abort(). Handlers that need sequential work
            // chain promises themselves; the bridge must stay pumpable.
            //
            // Errors surface as `notice` (a system chat bubble) rather
            // than `error` so they don't clobber the frontend's waiting
            // flag — a handler-side failure must not hide the Stop
            // button for whatever prompt the user actually has running.
            // Wrap the handler call inside the .then() callback so a
            // synchronous throw is caught by .catch() too — calling
            // handler(...) directly inside Promise.resolve(...) lets a
            // sync throw escape to the outer message-loop catch, which
            // would emit type:"error" and clear the frontend's waiting
            // state.
            Promise.resolve()
              .then(() =>
                handler(ev, {
                  setState: tabScopedSetState,
                  registerComponent: aethonApi.registerComponent,
                  pi: piCtx,
                }),
              )
              .catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                // Route the notice back to the originating tab so the
                // error appears in the conversation the user clicked
                // from, not whichever tab is currently active.
                send({ type: "notice", tabId: handlerTabId, message: `a2ui handler: ${message}` });
              });
          }
          break;
        }
        case "register_component": {
          // External registration path — same surface as ctx.aethon
          // .registerComponent in extensions, but accessible over the
          // protocol so debug tools and one-off scripts can register
          // templates without packaging a full extension.
          if (!msg.componentType) {
            send({
              type: "error",
              message: "register_component: missing componentType",
            });
            break;
          }
          aethonApi.registerComponent(msg.componentType, msg.template);
          break;
        }
        case "set_state": {
          if (!msg.path) {
            send({ type: "error", message: "set_state: missing path" });
            break;
          }
          aethonApi.setState(msg.path, msg.value);
          break;
        }
        case "set_layout": {
          if (!msg.payload) {
            send({ type: "error", message: "set_layout: missing payload" });
            break;
          }
          aethonApi.setLayout(msg.payload);
          break;
        }
        case "patch_layout": {
          if (!msg.path) {
            send({ type: "error", message: "patch_layout: missing path" });
            break;
          }
          aethonApi.patchLayout(msg.path, msg.value);
          break;
        }
        case "register_theme": {
          if (!msg.theme) {
            send({ type: "error", message: "register_theme: missing theme" });
            break;
          }
          aethonApi.registerTheme(msg.theme);
          break;
        }
        default: {
          send({ type: "error", message: `unknown message type: ${msg.type}` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "error", message });
    }
  }
}

main().catch((err) => {
  send({ type: "error", message: `fatal: ${err?.message ?? err}` });
  process.exit(1);
});
