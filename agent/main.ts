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
  type A2UIEventHandler = (
    event: A2UIEventInfo,
    ctx: { setState: AethonApi["setState"]; registerComponent: AethonApi["registerComponent"] },
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
  function _setState(path: string, value: unknown): void {
    if (!path || typeof path !== "string") return;
    extensionStateTree = setAtPointer(extensionStateTree, path, value);
    send({ type: "state_patch", path, value });
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

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
  });

  // Filter the picker to the user's enabledModels patterns from
  // ~/.pi/agent/settings.json. Patterns may include `*` wildcards
  // (e.g., "anthropic/claude-*"). When no patterns are configured,
  // fall back to authed models so the picker is never empty.
  const all = modelRegistry.getAll();
  const enabled = settingsManager.getEnabledModels();
  let pickerModels: Model<Api>[];
  if (enabled && enabled.length > 0) {
    const patterns = enabled.map(compilePattern);
    pickerModels = all.filter((m) => {
      const key = modelKey(m);
      return patterns.some((p) => p.test(key));
    });
  } else {
    pickerModels = modelRegistry.getAvailable();
  }

  // Always include the current session model so the active model is
  // selectable even if its provider isn't authed or matched.
  const seen = new Set(pickerModels.map(modelKey));
  if (session.model && !seen.has(modelKey(session.model))) {
    pickerModels.unshift(session.model);
  }
  const models = pickerModels.map(modelDescriptor);

  function emitReady() {
    const currentModelId = session.model ? modelKey(session.model) : "";
    send({
      type: "ready",
      model: currentModelId,
      models,
      extensionComponents: Object.fromEntries(extensionComponents),
      extensionState: extensionStateTree,
      extensionLayout,
      extensionLayoutPatches: pendingLayoutPatches,
      extensionThemes: [...extensionThemes.values()],
    });
  }

  // Discover Aethon-only extensions in `~/.aethon/extensions/*.ts` and call
  // their `register(api)` default export. (Pi extensions reach the same API
  // via `globalThis.aethon` — set above before createAgentSession.)
  // Failures in one extension don't block others.
  await loadAethonExtensions(aethonApi);

  emitReady();

  // Cache tool args from start so we can include them in the end-state card
  // (tool_execution_end doesn't carry args).
  const toolArgsCache = new Map<string, { name: string; summary: string }>();

  // Tracks whether a prompt is mid-flight (between `session.prompt()` call
  // and the agent_end event). Used to reject overlapping `chat` messages so
  // the frontend doesn't get confused by AgentSession's "already processing"
  // rejection. `agentEndFired` distinguishes prompts that triggered an agent
  // run from prompts pi handled without one (e.g. server-side slash commands
  // that short-circuit before invoking the LLM).
  let promptInFlight = false;
  let agentEndFired = false;

  // Format and forward bash output to the terminal panel in chunks. Caps a
  // single emit at TERMINAL_MAX_BYTES (trailing window) so a sudden burst
  // can't choke the IPC pipe.
  //
  // We deliberately only stream on tool_execution_end, not partial updates.
  // pi's bash tool exposes `partialResult.text` as a rolling tail (see
  // pi-coding-agent/.../core/tools/bash.js — "rolling buffer of recent
  // output for tail truncation"), so accumulating from partials reliably
  // would require either (a) an upstream cumulative byte counter we don't
  // have or (b) overlap matching that breaks on identical repeated chunks.
  // Streaming only the final result avoids gap/duplication tradeoffs at
  // the cost of not seeing live progress on long-running commands.
  const TERMINAL_MAX_BYTES = 64 * 1024;
  const TERMINAL_CHUNK_BYTES = 8 * 1024;

  function emitBashResult(text: string): void {
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
        content: `\r\n[…output truncated to last ${TERMINAL_MAX_BYTES} bytes]\r\n`,
      });
    }
    const normalized = body.replace(/\r?\n/g, "\r\n");
    for (let i = 0; i < normalized.length; i += TERMINAL_CHUNK_BYTES) {
      send({
        type: "terminal_output",
        content: normalized.slice(i, i + TERMINAL_CHUNK_BYTES),
      });
    }
  }

  // Stream text deltas, surface tool calls as A2UI cards, and flush
  // `response_end` when the agent settles. The frontend appends text deltas
  // to the trailing chat bubble, replaces tool messages by their stable id
  // (so "running…" → "done" updates in place), and unsets the waiting flag
  // on response_end.
  session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        if (event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta ?? "";
          if (delta) {
            // pi assigns each AssistantMessage a unique `timestamp` at message
            // start; reuse it as a stable per-message id so the frontend can
            // append later deltas to the same chat bubble after tool calls.
            const ts =
              (event.message as { timestamp?: number } | undefined)?.timestamp ?? 0;
            const messageId = `text-${ts}`;
            send({ type: "response_delta", messageId, content: delta });
          }
        }
        break;
      }
      case "tool_execution_start": {
        const summary = summarizeToolArgs(event.toolName, event.args);
        toolArgsCache.set(event.toolCallId, { name: event.toolName, summary });
        const payload = toolCardPayload({
          callId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: summary,
          running: true,
        });
        send({ type: "a2ui", id: `tool-${event.toolCallId}`, payload });
        // Echo the bash command into the visible terminal panel so the user
        // can follow what the agent is running. The card uses a one-line
        // summary, but here we want the verbatim multi-line command so
        // heredocs / inline scripts read accurately in xterm.
        if (event.toolName === "bash") {
          const cmd = String(
            (event.args as { command?: unknown } | undefined)?.command ?? "",
          );
          const echoed = cmd.replace(/\r?\n/g, "\r\n");
          send({
            type: "terminal_output",
            content: `\r\n$ ${echoed}\r\n`,
          });
        }
        break;
      }
      case "tool_execution_end": {
        const cached = toolArgsCache.get(event.toolCallId);
        const payload = toolCardPayload({
          callId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: cached?.summary ?? "",
          result: event.result,
          isError: event.isError,
        });
        send({ type: "a2ui", id: `tool-${event.toolCallId}`, payload });
        if (event.toolName === "bash") {
          const extracted = extractToolContent(event.result);
          emitBashResult(extracted.text);
          send({ type: "terminal_output", content: "\r\n" });
        }
        toolArgsCache.delete(event.toolCallId);
        break;
      }
      case "agent_end": {
        agentEndFired = true;
        promptInFlight = false;
        send({ type: "response_end" });
        break;
      }
    }
  });

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: {
      type: string;
      content?: string;
      id?: string;
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
          // Gate concurrent chats: pi's session.prompt() rejects with
          // "Agent is already processing" if called while a previous run
          // is still streaming. The UI's chat-input is disabled while
          // waiting, but a stray IPC could still arrive — bounce it
          // explicitly so the frontend doesn't mistake the rejection for
          // a real response_end.
          if (promptInFlight) {
            // `error` would flip the frontend's waiting=false, taking the
            // Stop button down even though the first prompt is still
            // running. `notice` is a non-terminal system message instead.
            send({ type: "notice", message: "agent busy — send /stop first" });
            break;
          }
          // CRITICAL: do NOT await — `for await (const line of rl)` processes
          // one stdin line at a time, so awaiting here would queue any
          // subsequent "stop" message behind the in-flight prompt and Stop
          // would never reach session.abort() until the prompt finished
          // naturally. Track in-flight state via promptInFlight so we can
          // reject overlapping chats above; cleared on agent_end OR in
          // .finally() if pi short-circuited the prompt without an agent
          // run (e.g. a server-side slash command). The finally branch
          // also synthesizes a `response_end` so the frontend's waiting
          // flag clears when no streaming happened.
          promptInFlight = true;
          agentEndFired = false;
          session
            .prompt(msg.content)
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              send({ type: "error", message: `prompt: ${message}` });
            })
            .finally(() => {
              if (!agentEndFired) {
                promptInFlight = false;
                send({ type: "response_end" });
              }
            });
          break;
        }
        case "set_model": {
          if (!msg.id) {
            send({ type: "error", message: "set_model: missing id" });
            break;
          }
          // Same in-flight gate as `chat`: pi rejects setModel while a run
          // is active, and the resulting `error` would clobber waiting=true
          // and hide the Stop button on the original prompt. Surface as a
          // non-terminal notice instead so the user keeps their stop UI.
          if (promptInFlight) {
            send({
              type: "notice",
              message: "agent busy — stop the current prompt before switching models",
            });
            break;
          }
          const [provider, ...rest] = msg.id.split("/");
          const id = rest.join("/");
          const next = modelRegistry.find(provider, id);
          if (!next) {
            send({ type: "error", message: `set_model: unknown model ${msg.id}` });
            break;
          }
          await session.setModel(next);
          send({ type: "model_changed", model: msg.id });
          break;
        }
        case "stop": {
          // session.abort() cancels the LLM stream / agent loop. The agent's
          // run signal propagates to the bash tool's `signal.addEventListener
          // ("abort", ...)` handler, which calls killProcessTree(child.pid),
          // so any in-flight bash subprocess gets SIGKILLed. Don't await —
          // we want to free the message loop immediately so a follow-up
          // chat doesn't queue behind a slow settle.
          session.abort().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            send({ type: "error", message: `abort: ${message}` });
          });
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
          for (const { match, handler } of a2uiEventHandlers) {
            if (match.templateRootType && match.templateRootType !== ev.templateRootType) continue;
            if (match.componentType && match.componentType !== ev.componentType) continue;
            if (match.eventType && match.eventType !== ev.eventType) continue;
            if (match.descendantId && match.descendantId !== descendantId) continue;
            try {
              await handler(ev, {
                setState: aethonApi.setState,
                registerComponent: aethonApi.registerComponent,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              send({ type: "error", message: `a2ui handler: ${message}` });
            }
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
