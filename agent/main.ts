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
 *   { "type": "mutation_ack", "mutationId": "...", "success": true, "error"?: "..." }
 *      // Frontend acks a mutation it received. Resolves the bridge-side
 *      // Promise so the awaiting extension call returns
 *      // {ok:true} (or {ok:false, error} on failure). Sent for every
 *      // mutating outbound message that carries a `mutationId`.
 *   { "type": "frontend_state_patch", "path": "/sidebar/models", "value": <any> }
 *      // One-way mirror — frontend pushes a slice value the bridge
 *      // wouldn't otherwise see (model picker, themes, connection,
 *      // status, tabs, draft, messagesCount). Stored in `frontendState`
 *      // map and exposed via `aethon.getFrontendState(path)` and the
 *      // `uiState` field of `getRuntimeSnapshot()`. Best-effort, no ack.
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
 *   { "type": "extension_components", "mutationId"?: "...", "components": {<componentType>: <template>, ...} }
 *      // Emitted after each registration delta; frontend hydrates templates
 *      // into the SkillRegistry. Carries mutationId so the extension can
 *      // await the registration outcome.
 *   { "type": "state_patch", "mutationId"?: "...", "path": "/foo", "value": <any> }
 *      // Forward of an extension's set_state call. Frontend applies via
 *      // JSON Pointer. mutationId set when an awaiter wants confirmation.
 *   { "type": "layout_set", "mutationId"?: "...", "payload": {...} }
 *      // Replace the active A2UI layout. Frontend calls window.aethon.setLayout.
 *   { "type": "layout_patch", "mutationId"?: "...", "path": "/foo", "value": <any> }
 *      // Patch a path inside the active layout payload via JSON Pointer.
 *   { "type": "extension_themes", "mutationId"?: "...", "themes": [{id, label, vars}, ...] }
 *      // Emitted after each registerTheme call. The frontend rebuilds its
 *      // theme registry from the full list (no incremental delta).
 *   { "type": "extension_slash_commands", "mutationId"?: "...", "commands": [{name, description, usage?}, ...] }
 *      // Emitted after each registerSlashCommand call. Frontend merges
 *      // with built-ins for the slash-command picker. Invocations
 *      // dispatch through the existing a2ui_event route as
 *      // {componentType: "slash-command", componentId: "slash-command__tpl__<name>",
 *      //  data: {args}} so a paired aethon.onEvent matcher fires the handler.
 *   { "type": "extension_event_routes", "mutationId"?: "...", "routes": [{componentId?, eventType?}, ...] }
 *      // Emitted after each registerEventRoute / unregisterEventRoute
 *      // call. Frontend stores the list and matches outbound renderer
 *      // events against it before running the built-in dispatcher.
 *      // Matching events skip the built-in switch and forward to the
 *      // bridge as a2ui_event so a paired aethon.onEvent handler
 *      // intercepts.
 *      // When "mode" is "extension", every layout event bypasses the
 *      // built-in dispatcher so extensions can replace the route table.
 *   { "type": "extension_menu_items", "mutationId"?: "...", "items": [{id, label, action, location, parent?}, ...] }
 *      // Emitted after each registerMenuItem / unregisterMenuItem call.
 *      // Frontend forwards to the `set_extension_menu_items` Tauri
 *      // command which rebuilds the native app + tray menus. Clicks
 *      // emit `menu` events with id `ext:<action>` which the frontend
 *      // dispatcher routes via a2ui_event so a paired
 *      // aethon.onEvent({componentType:"menu-item", descendantId:"<action>"})
 *      // handler fires.
 *   { "type": "extension_keybindings", "mutationId"?: "...", "bindings": [{combo, action, description?}, ...] }
 *      // Emitted after each registerKeybinding / unregisterKeybinding
 *      // call. Frontend matches keydown events against the canonicalized
 *      // combo and dispatches via a2ui_event as {componentType: "keybinding",
 *      // componentId: "keybinding__tpl__<combo>", data: {action, combo}}
 *      // so aethon.onEvent({componentType: "keybinding", descendantId})
 *      // fires the handler.
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
 *   { "type": "session_history", "tabId": "<tab-id>", "messages": [...] }
 *      // Text transcript replay from a restored tab's pi JSONL log.
 *      // Sent only when the frontend opens a tab with restoreHistory=true.
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
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { findProjectExtensionDirs } from "./project-extensions";
import {
  readSessionMetadata,
  readSessionTranscript,
} from "./session-history";
import {
  resolveAethonSystemPrompt,
  type RuntimeSnapshot,
} from "./system-prompt";
import {
  consumeBashTerminalSnapshot,
  type BashTerminalStreamState,
} from "./terminal-stream";

// Filesystem locations passed in by the Tauri shell. They have sensible
// defaults so the bridge still runs when launched directly (tests, dev
// against `bun run agent/main.ts` without Tauri). The shell sets these
// to absolute paths in both dev and release.
const USER_DIR =
  process.env.AETHON_USER_DIR ?? join(homedir(), ".aethon");
const STATE_FILE =
  process.env.AETHON_STATE_FILE ?? join(USER_DIR, "state.json");
const SESSIONS_DIR =
  process.env.AETHON_SESSIONS_DIR ?? join(USER_DIR, "sessions");
const DOCS_DIR = process.env.AETHON_DOCS_DIR;
const PROJECT_ROOT = process.env.AETHON_PROJECT_ROOT;
const RELEASE_MODE = process.env.AETHON_RELEASE_MODE === "1";
const BOOT_LAYOUT_FILE = process.env.AETHON_BOOT_LAYOUT_FILE;
const LAYOUT_SLOTS_FILE = process.env.AETHON_LAYOUT_SLOTS_FILE;

// Source attribution for the loaded-extension list. "directory" =
// ~/.aethon/extensions/*.{ts,js,mjs}, "project-directory" =
// <project>/.aethon/extensions/*.{ts,js,mjs}, "skill-package" =
// npm-style install under ~/.aethon/skills/node_modules/, and
// "pi-extension" = discovered in ~/.pi/agent/extensions/ and observed to
// touch `globalThis.aethon`. Used to surface this in the state file and
// the runtime snapshot.
type ExtensionSource =
  | "directory"
  | "project-directory"
  | "skill-package"
  | "pi-extension";

// Per-turn tabId propagated through the async call chain that runs
// inside session.prompt(). Concurrent prompts on different tabs each
// get their own store, so a setState fired from inside one tab's
// agent code doesn't get attributed to whichever tab last started.
const tabContext = new AsyncLocalStorage<string>();

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Mutation feedback — every mutating bridge → frontend message carries a
// `mutationId`. The frontend acks via `mutation_ack { mutationId, success,
// error? }` after applying. Bridge resolves a Promise so the API can return
// `Promise<MutationResult>` and the agent can `await` for confirmation.
//
// Backwards compatibility: callers that don't await the Promise see the
// old fire-and-forget semantics. Mutations made before the frontend
// reports `ready` resolve immediately with {ok:true} on the assumption
// that retained-state replay will deliver them — otherwise an extension
// that awaits at register-time would block until the webview connects.
export interface MutationResult {
  ok: boolean;
  /** Frontend-reported reason on failure. Common values:
   *  - "frontend_rejected: <detail>" — explicit ack failure
   *  - "timeout"                      — no ack within MUTATION_ACK_TIMEOUT_MS
   *  - "frontend_disconnected"        — bridge died mid-flight
   */
  error?: string;
}
const MUTATION_ACK_TIMEOUT_MS = 5_000;
let _mutationCounter = 0;
function nextMutationId(): string {
  _mutationCounter += 1;
  return `m${Date.now().toString(36)}-${_mutationCounter}`;
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
const RESERVED_THEME_IDS = new Set(["ember", "paper", "aether", "signature"]);

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

// Discover and load Aethon-shipped npm packages from ~/.aethon/skills/.
// Each install root (Aethon walks ~/.aethon/skills/node_modules and
// ~/.aethon/skills/node_modules/@scope/*) is a normal npm package whose
// package.json declares an `aethon` field with at least an `entry`
// pointing at the module to import. The module exports `register(api)`
// (named or default), called with the same Aethon API surface as
// directory-based extensions. Layout: same JSON shape, but resolvable
// via `bun install` / `npm install` inside the skills dir, so users
// can `npm install --prefix ~/.aethon/skills <pkg>` and Aethon picks
// it up on next reload.
//
// Manifest example:
//   {
//     "name": "@example/aethon-pretty-themes",
//     "aethon": { "entry": "./dist/index.js" }
//   }
async function loadAethonSkillManifests(
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
): Promise<void> {
  const skillsRoot = join(USER_DIR, "skills", "node_modules");
  // Each candidate is { displayName, packageDir, manifest }
  type Candidate = {
    name: string;
    dir: string;
    manifest: { name?: string; aethon?: { entry?: string } };
  };
  const candidates: Candidate[] = [];

  async function readManifest(packageDir: string): Promise<Candidate | null> {
    try {
      const pkgPath = join(packageDir, "package.json");
      const text = await Bun.file(pkgPath).text();
      const manifest = JSON.parse(text) as Candidate["manifest"];
      if (!manifest.aethon) return null;
      return { name: manifest.name ?? packageDir, dir: packageDir, manifest };
    } catch {
      return null;
    }
  }

  let entries: string[];
  try {
    entries = await readdir(skillsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-skill] readdir ${skillsRoot}: ${(err as Error).message}`);
    }
    return;
  }
  for (const entry of entries) {
    const entryPath = join(skillsRoot, entry);
    if (entry.startsWith("@")) {
      // Scoped namespace — recurse one level.
      let scoped: string[];
      try { scoped = await readdir(entryPath); } catch { continue; }
      for (const sub of scoped) {
        const c = await readManifest(join(entryPath, sub));
        if (c) candidates.push(c);
      }
    } else {
      const c = await readManifest(entryPath);
      if (c) candidates.push(c);
    }
  }
  for (const c of candidates) {
    const entry = c.manifest.aethon?.entry;
    if (typeof entry !== "string" || entry.length === 0) {
      console.error(`[aethon-skill] ${c.name}: aethon.entry not set, skipping`);
      send({
        type: "extension_lifecycle",
        name: c.name,
        source: "skill-package",
        status: "skipped",
        error: "aethon.entry not set",
        path: c.dir,
      });
      continue;
    }
    const filePath = join(c.dir, entry);
    try {
      const mod: AethonExtensionModule = await import(pathToFileURL(filePath).href);
      const register = mod.register ?? mod.default?.register;
      if (typeof register !== "function") {
        console.error(`[aethon-skill] ${c.name}: no register() export, skipping`);
        send({
          type: "extension_lifecycle",
          name: c.name,
          source: "skill-package",
          status: "skipped",
          error: "no register() export",
          path: filePath,
        });
        continue;
      }
      await register(api);
      registry.set(c.name, "skill-package");
      console.error(`[aethon-skill] loaded ${c.name} from ${entry}`);
      send({
        type: "extension_lifecycle",
        name: c.name,
        source: "skill-package",
        status: "loaded",
        path: filePath,
      });
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[aethon-skill] ${c.name}: ${message}`);
      send({
        type: "extension_lifecycle",
        name: c.name,
        source: "skill-package",
        status: "failed",
        error: message,
        path: filePath,
      });
    }
  }
}

// Discover pi extensions that touch `globalThis.aethon`. Pi loads its
// own extensions from ~/.pi/agent/extensions/ — we don't load them, but
// the agent should know they exist so it can answer "what extensions
// drive the GUI?" without scraping the filesystem itself. We grep each
// file for "globalThis.aethon" or "aethon.register" as a cheap signal
// of Aethon-awareness; non-Aethon pi extensions are skipped to keep
// the snapshot focused on UI-affecting code.
//
// File-only discovery — we don't recursively walk subdirs. Pi also
// supports `<dir>/index.ts` and project-local `.pi/extensions/`; if
// users start relying on those for Aethon-aware extensions we can
// extend this to match. Errors per file are swallowed so one
// unreadable file doesn't break the whole scan.
async function discoverPiAethonExtensions(
  registry: Map<string, ExtensionSource>,
): Promise<void> {
  const dir = join(homedir(), ".pi", "agent", "extensions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-pi] readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      if (!text.includes("globalThis.aethon") && !text.includes("aethon.register")) {
        continue;
      }
      const display = name.replace(/\.(ts|js|mjs)$/, "");
      // Don't overwrite an existing entry from a higher-precedence
      // source — Aethon-direct (`directory`) extensions win over pi-side.
      if (!registry.has(display)) {
        registry.set(display, "pi-extension");
      }
    } catch {
      // Unreadable file — skip silently. Pi will surface its own load
      // error if the file is truly broken at import time.
    }
  }
}

// Discover persisted per-tab sessions on disk under SESSIONS_DIR/<tabId>/.
// Each subdir holds the rolling JSONL files SessionManager.continueRecent
// resumes from. Returns an array of {tabId, lastModified} for the bridge
// to ship in `ready` so the frontend can surface them in the empty-state
// "Recent sessions" list and reopen on demand.
//
// "default" is excluded — the frontend always pre-creates a default tab,
// and surfacing it as "recent" would duplicate it. Other tabIds are
// presented in lastModified-descending order (most recent first). The
// newest JSONL file's `session.cwd` is included when available so the
// frontend can scope Chat History by active project and restore the tab
// against the same working directory pi used originally.
async function discoverPersistedTabs(): Promise<
  { tabId: string; lastModified: number; cwd?: string }[]
> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[aethon-tabs] readdir ${SESSIONS_DIR}: ${(err as Error).message}`,
      );
    }
    return [];
  }
  const results: { tabId: string; lastModified: number; cwd?: string }[] = [];
  for (const name of entries) {
    if (name === "default") continue;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
    const dir = join(SESSIONS_DIR, name);
    try {
      const meta = await readSessionMetadata(dir);
      if (meta) results.push({ tabId: name, ...meta });
    } catch {
      /* skip — best effort */
    }
  }
  results.sort((a, b) => b.lastModified - a.lastModified);
  return results;
}

// Discover and load loose-file themes from ~/.aethon/themes/*.json.
// Each file is a JSON object matching the registerTheme contract:
//   { id: string, label?: string, vars: { "--bg": "...", "--text": "...", ... } }
// Validated through the bridge's existing normalizeTheme so reserved ids
// (signature) and malformed CSS variable names are rejected the same way
// as extension-registered themes. Failures per file are logged and the
// loader continues — one bad theme doesn't poison the directory.
async function loadAethonThemeDirectory(
  api: { registerTheme: (theme: unknown) => unknown },
): Promise<void> {
  const dir = join(USER_DIR, "themes");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-themes] readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      const parsed = JSON.parse(text) as unknown;
      // registerTheme handles validation internally — invalid input emits
      // a notice and resolves with {ok:false}.
      api.registerTheme(parsed);
      console.error(`[aethon-themes] loaded ${name}`);
    } catch (err) {
      console.error(`[aethon-themes] ${name}: ${(err as Error).message}`);
    }
  }
}

function projectExtensionDisplayName(
  projectRoot: string,
  extensionDir: string,
  fileName: string,
): string {
  const extensionBase = fileName.replace(/\.(ts|js|mjs)$/, "");
  const scopeDir = dirname(dirname(extensionDir));
  const rootName = basename(projectRoot) || "project";
  const scope = relative(projectRoot, scopeDir).replace(/\\/g, "/");
  return scope && !scope.startsWith("..")
    ? `${rootName}/${scope}:${extensionBase}`
    : `${rootName}:${extensionBase}`;
}

async function loadAethonExtensionDirectory(
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  options: {
    dir: string;
    source: Extract<ExtensionSource, "directory" | "project-directory">;
    logPrefix: string;
    displayName?: (fileName: string) => string;
    loadedFiles?: Set<string>;
  },
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(options.dir);
  } catch (err) {
    // Missing dir is the common case — extensions are optional.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[${options.logPrefix}] readdir ${options.dir}: ${(err as Error).message}`,
      );
    }
    return;
  }
  for (const name of entries) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    const file = join(options.dir, name);
    if (options.loadedFiles?.has(file)) continue;
    const displayName =
      options.displayName?.(name) ?? name.replace(/\.(ts|js|mjs)$/, "");
    try {
      const mod: AethonExtensionModule = await import(pathToFileURL(file).href);
      const register = mod.register ?? mod.default?.register;
      if (typeof register !== "function") {
        console.error(`[${options.logPrefix}] ${name}: no register() export, skipping`);
        // Lifecycle event — abstract feedback channel. Default-layout
        // surfaces this as a chat-side system notice; other layouts /
        // extensions can listen on `aethon:extension-lifecycle` and
        // render however they want (toast, sidebar pulse, etc.).
        send({
          type: "extension_lifecycle",
          name: displayName,
          source: options.source,
          status: "skipped",
          error: "no register() export",
          path: file,
        });
        continue;
      }
      await register(api);
      options.loadedFiles?.add(file);
      registry.set(displayName, options.source);
      console.error(`[${options.logPrefix}] loaded ${name}`);
      send({
        type: "extension_lifecycle",
        name: displayName,
        source: options.source,
        status: "loaded",
        path: file,
      });
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[${options.logPrefix}] ${name}: ${message}`);
      send({
        type: "extension_lifecycle",
        name: displayName,
        source: options.source,
        status: "failed",
        error: message,
        path: file,
      });
    }
  }
}

// Discover and load Aethon extensions from ~/.aethon/extensions/*.{ts,js}.
// Each extension exports `register(api)` (named or as default.register).
// Bun executes .ts directly so authors don't need a build step.
async function loadAethonExtensions(
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
): Promise<void> {
  await loadAethonExtensionDirectory(api, registry, {
    dir: join(USER_DIR, "extensions"),
    source: "directory",
    logPrefix: "aethon-ext",
  });
}

async function loadProjectAethonExtensions(
  cwd: string,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  loadedFiles: Set<string>,
): Promise<number> {
  const dirs = await findProjectExtensionDirs(cwd);
  const before = loadedFiles.size;
  for (const { projectRoot, extensionDir } of dirs) {
    await loadAethonExtensionDirectory(api, registry, {
      dir: extensionDir,
      source: "project-directory",
      logPrefix: "aethon-project-ext",
      loadedFiles,
      displayName: (name) => projectExtensionDisplayName(projectRoot, extensionDir, name),
    });
  }
  return loadedFiles.size - before;
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

  // Per-tab record. Hoisted up here (above getRuntimeSnapshot) because
  // resolveAethonSystemPrompt → getRuntimeSnapshot fires during the
  // resourceLoader.reload() call below, before the original declaration
  // site would have run. The tabs map starts empty; it's filled by
  // ensureTab() once extensions and the default tab are set up.
  interface TabRecord {
    id: string;
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    toolArgsCache: Map<string, {
      name: string;
      summary: string;
      bashStream?: BashTerminalStreamState;
    }>;
    promptInFlight: boolean;
    agentEndFired: boolean;
    queuedCount: number;
  }
  const tabs = new Map<string, TabRecord>();

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
  // Every JSON Pointer path written via extension setState (excluding the
  // per-tab mirrored slices below). Reported in the `ready` snapshot so
  // the frontend can wipe stale slices when an extension is uninstalled
  // — the next ready's tree no longer has those paths, but the frontend's
  // local state still does. The frontend uses the previous ready's set
  // as the "what to clear" list before merging the new tree.
  const extensionStateKeys = new Set<string>();
  // Per-tab mirrored-key writes (canvas / messages / draft / waiting /
  // queueCount / model). Kept separate from the global extensionStateTree
  // so a webview reload's `ready` can replay each tab's UI state without
  // smearing one tab's writes into another. Frontend reads this from
  // data.extensionTabState on ready and merges per tab record.
  const perTabExtState = new Map<string, Record<string, unknown>>();
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
  // Canonical boot layout shipped by the active default-layout skill.
  // Loaded SYNCHRONOUSLY from $AETHON_BOOT_LAYOUT_FILE before any
  // extension runs, so `_getLayout()` returns a meaningful tree at
  // register-time. The frontend can also push a `boot_layout` message
  // later (e.g. when the user activates a different layout skill) to
  // refresh this — see the `boot_layout` inbound handler.
  //
  // Without this preload, getLayout() returned `null` during register()
  // and any extension that read the current tree to compute a patch
  // bailed out before doing any work — the exact failure mode the user
  // hit with right-sidebar-model-picker in release mode.
  let bootLayout: unknown = undefined;
  if (BOOT_LAYOUT_FILE) {
    try {
      const text = readFileSync(BOOT_LAYOUT_FILE, "utf8");
      bootLayout = JSON.parse(text);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(
          `[aethon-boot] read ${BOOT_LAYOUT_FILE}: ${(err as Error).message}`,
        );
      }
      // ENOENT is fine outside Tauri-spawned dev; getLayout() falls
      // back to null and the system prompt still tells the agent to
      // call patchLayout against known default-layout paths.
    }
  }

  // Layout-slot catalogue. Same pattern as the boot layout: shipped as a
  // bundled resource, read SYNCHRONOUSLY at boot so getLayoutSlots() and
  // the runtime-snapshot section have the contract available before any
  // extension calls register*. Falls back to undefined when the env var
  // isn't set (running outside the Tauri shell, e.g. raw `bun run`).
  interface LayoutSlotsCatalogue {
    version: number;
    description: string;
    slots: Record<
      string,
      { description: string; defaultComposite: string; required: boolean }
    >;
  }
  let layoutSlotsCatalogue: LayoutSlotsCatalogue | undefined;
  if (LAYOUT_SLOTS_FILE) {
    try {
      const text = readFileSync(LAYOUT_SLOTS_FILE, "utf8");
      layoutSlotsCatalogue = JSON.parse(text);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(
          `[aethon-slots] read ${LAYOUT_SLOTS_FILE}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Loaded extension registry. Populated by loadAethonExtensions and
  // loadAethonSkillManifests at startup. Used by getRuntimeSnapshot and
  // the listExtensions introspection method so the agent (and any user
  // querying the state file) can see what's actually been loaded —
  // previously the bridge had no record and the agent had to guess.
  const loadedExtensions = new Map<string, ExtensionSource>();
  // Project-local extension discovery can run on startup, tab_open, and
  // set_project. Track absolute files so switching back to the same project
  // doesn't duplicate event handlers or repeated UI mutations.
  const loadedProjectExtensionFiles = new Set<string>();

  // Event routes registered by extensions. Keyed by
  // `<componentId>:<eventType>` (where empty fields match everything).
  // When the frontend's renderer fires an event that matches one of
  // these routes, it skips the built-in dispatcher and forwards the
  // event to the bridge as a normal `a2ui_event`, so a paired
  // `aethon.onEvent({componentType, descendantId})` handler runs
  // instead of the hardcoded App.tsx switch. Lets extensions intercept
  // chat-input submits, sidebar clicks, etc. without forking React.
  const extensionEventRoutes = new Map<
    string,
    { componentId?: string; eventType?: string }
  >();
  let eventRoutingMode: "builtin" | "extension" = "builtin";

  // Menu items registered by extensions. Surfaced to the frontend as
  // an `extension_menu_items` event; the React side invokes a Tauri
  // command that rebuilds the native menu (App menu and / or tray) so
  // extension entries appear next to the built-ins. Clicks emit the
  // standard `menu` Tauri event with the prefixed id `ext:<action>`,
  // which the React menu dispatcher routes via `a2ui_event` so a paired
  // `aethon.onEvent({componentType: "menu-item", descendantId: <action>})`
  // matcher fires the handler.
  const extensionMenuItems = new Map<
    string,
    {
      id: string;
      label: string;
      action: string;
      location: "app" | "tray";
      parent?: string;
    }
  >();

  // Keybindings registered by extensions. Combo is a "+"-joined token
  // ("Cmd+Shift+P", "Ctrl+]", "Alt+M") — frontend normalizes to a canonical
  // form for keydown matching. Action is an opaque string the handler
  // can branch on; defaults to the combo. Same dispatch shape as slash
  // commands: paired with aethon.onEvent({componentType: "keybinding",
  // descendantId: "<combo>"}, handler) for the actual behavior.
  const extensionKeybindings = new Map<
    string,
    { combo: string; action: string; description?: string }
  >();

  // Slash commands registered by extensions. Surfaced to the frontend
  // so the chat-input picker shows them alongside the built-ins; clicks
  // dispatch through the existing `a2ui_event` route as
  // {componentType: "slash-command", componentId: "slash-command__tpl__<name>",
  //  data: {args}} so a paired `aethon.onEvent({componentType: "slash-command",
  //  descendantId: "<name>"}, handler)` matcher fires the handler with no
  // bespoke dispatch path.
  const extensionSlashCommands = new Map<
    string,
    { name: string; description: string; usage?: string }
  >();

  // Bridge-readable mirror of frontend-populated state slices. The
  // frontend pushes `frontend_state_patch { path, value }` whenever an
  // allowlisted slice changes (models, themes, connection, status, tabs,
  // draft, messagesCount). Without this, extensions calling
  // `aethon.getFrontendState("/sidebar/models")` would have to scrape
  // — the bridge sees only its own writes via setState. Surface in
  // getRuntimeSnapshot().uiState too so the agent's first-turn snapshot
  // includes what's currently on screen, not just what was registered.
  const frontendState = new Map<string, unknown>();

  // Compose a one-line summary of the active layout for the runtime
  // snapshot. The full layout is available via getLayout(); this is a
  // human-readable hint suitable for the system prompt and state file.
  function summarizeLayout(): string {
    // Source: extensionLayout if set (full replacement), otherwise the
    // boot layout with all pendingLayoutPatches folded in. That way the
    // summary reflects what's actually rendered, not a stale snapshot.
    let layout: unknown;
    let prefix: string;
    if (extensionLayout) {
      layout = extensionLayout;
      prefix = "extension layout (setLayout)";
    } else if (bootLayout) {
      let tree = bootLayout;
      for (const { path, value } of pendingLayoutPatches) {
        tree = patchLayoutTree(tree, path, value);
      }
      layout = tree;
      prefix =
        pendingLayoutPatches.length > 0
          ? `default-layout (boot tree + ${pendingLayoutPatches.length} patch(es))`
          : "default-layout (boot tree)";
    } else {
      // No layout known — bridge spawned without a boot file and no
      // extension has shipped one yet.
      return pendingLayoutPatches.length > 0
        ? `unknown layout (${pendingLayoutPatches.length} pending patch(es))`
        : "unknown layout (no boot tree)";
    }
    const typed = layout as { components?: unknown[] } | null;
    const root = typed?.components?.[0] as
      | { type?: string; props?: { columns?: string; areas?: string[] } }
      | undefined;
    const cols = root?.props?.columns ?? "?";
    const sidebarSide = (() => {
      const areas = root?.props?.areas;
      if (!Array.isArray(areas) || areas.length === 0) return "?";
      const firstRow = String(areas[0]).split(/\s+/);
      if (firstRow[0] === "sidebar") return "left";
      if (firstRow[firstRow.length - 1] === "sidebar") return "right";
      return "custom";
    })();
    return `${prefix} — root=${root?.type ?? "?"}, columns="${cols}", sidebar=${sidebarSide}`;
  }

  // Structural decomposition of the active layout: root id/type, grid
  // template, and a flat child list (id/type/area). Stripped of state /
  // props / nested children so the snapshot stays small. Null when no
  // tree is known yet.
  function summarizeLayoutStructure(): RuntimeSnapshot["layoutStructure"] {
    let layout: unknown;
    if (extensionLayout) {
      layout = extensionLayout;
    } else if (bootLayout) {
      let tree = bootLayout;
      for (const { path, value } of pendingLayoutPatches) {
        tree = patchLayoutTree(tree, path, value);
      }
      layout = tree;
    } else {
      return null;
    }
    const typed = layout as { components?: unknown[] } | null;
    const root = typed?.components?.[0] as
      | {
          id?: string;
          type?: string;
          props?: { columns?: string; rows?: string; areas?: string[] };
          children?: { id?: string; type?: string; props?: { area?: string } }[];
        }
      | undefined;
    if (!root) return null;
    return {
      rootId: root.id ?? "",
      rootType: root.type ?? "",
      ...(root.props?.columns ? { columns: root.props.columns } : {}),
      ...(root.props?.rows ? { rows: root.props.rows } : {}),
      ...(root.props?.areas ? { areas: root.props.areas } : {}),
      children: (root.children ?? []).map((c) => ({
        id: c.id ?? "",
        type: c.type ?? "",
        ...(c.props?.area ? { area: c.props.area } : {}),
      })),
    };
  }

  // Build the live runtime snapshot. Cheap; safe to call from the
  // appendSystemPromptOverride callback on every resourceLoader.reload.
  // Tab data is read from the live `tabs` Map declared further down,
  // so this closes over it after that map is created (the function is
  // never invoked before main() finishes setup).
  function getRuntimeSnapshot(): RuntimeSnapshot {
    return {
      release: RELEASE_MODE,
      cwd: process.cwd(),
      docsDir: DOCS_DIR,
      projectRoot: PROJECT_ROOT,
      userDir: USER_DIR,
      stateFile: STATE_FILE,
      extensions: [...loadedExtensions.entries()].map(([name, source]) => ({
        name,
        source,
      })),
      themes: [...extensionThemes.values()].map((t) => ({
        id: t.id,
        label: t.label,
      })),
      components: [...extensionComponents.keys()],
      layoutSummary: summarizeLayout(),
      tabs: [...tabs.values()].map((t) => ({
        id: t.id,
        model: t.session.model ? modelKey(t.session.model) : "",
        messageCount: t.session.messages?.length ?? 0,
      })),
      // Match-shape only — function bodies are intentionally not exposed.
      // Lets the agent see what's wired without scraping the registry.
      eventHandlers: a2uiEventHandlers.map(({ match }) => ({
        ...(match.templateRootType ? { templateRootType: match.templateRootType } : {}),
        ...(match.componentType ? { componentType: match.componentType } : {}),
        ...(match.descendantId ? { descendantId: match.descendantId } : {}),
        ...(match.eventType ? { eventType: match.eventType } : {}),
      })),
      slashCommands: [...extensionSlashCommands.values()],
      keybindings: [...extensionKeybindings.values()],
      menuItems: [...extensionMenuItems.values()],
      eventRoutes: [...extensionEventRoutes.values()],
      eventRoutingMode,
      uiState: Object.fromEntries(frontendState),
      layoutStructure: summarizeLayoutStructure(),
      layoutSlots: layoutSlotsCatalogue
        ? {
            version: layoutSlotsCatalogue.version,
            slots: layoutSlotsCatalogue.slots,
          }
        : null,
    };
  }

  // Persist a JSON snapshot to disk so the agent can `cat $AETHON_STATE_FILE`
  // and read fresh state without invoking JS. Debounced because bursty
  // registrations (a skill registering 5 themes in a row) shouldn't write
  // 5 times. The file is small (<10 KiB typically) so this is cheap.
  let stateFileTimer: ReturnType<typeof setTimeout> | null = null;
  let stateFileWriting = false;
  let stateFileDirty = false;
  function scheduleStateFileWrite() {
    stateFileDirty = true;
    if (stateFileTimer) return;
    stateFileTimer = setTimeout(async () => {
      stateFileTimer = null;
      // Coalesce again at flush time — additional dirties during the
      // 200 ms window will already be reflected in getRuntimeSnapshot().
      while (stateFileDirty) {
        stateFileDirty = false;
        if (stateFileWriting) return; // overlap guard
        stateFileWriting = true;
        try {
          mkdirSync(USER_DIR, { recursive: true });
          await writeFile(
            STATE_FILE,
            JSON.stringify(getRuntimeSnapshot(), null, 2),
          );
        } catch (err) {
          console.error(`[aethon-state] write ${STATE_FILE}: ${(err as Error).message}`);
        } finally {
          stateFileWriting = false;
        }
      }
    }, 200);
  }

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

  // Pending mutation acks — keyed by mutationId. Resolved when the
  // frontend sends `mutation_ack { mutationId, success, error? }`.
  // Each entry also has a timeout that auto-resolves with `{ok:false,
  // error:"timeout"}` after MUTATION_ACK_TIMEOUT_MS so a runaway extension
  // can't accumulate pending Promises forever (e.g. if the frontend
  // crashes between the bridge send and the ack).
  const pendingMutations = new Map<
    string,
    { resolve: (r: MutationResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // True once the frontend has reported `ready` (via the `report` inbound).
  // Mutations made before this resolve immediately with {ok:true} on the
  // assumption that retained-state replay will deliver them — extensions
  // that await at register-time would otherwise block 5s on the timeout.
  let frontendReady = false;

  function trackMutation(): { id: string; promise: Promise<MutationResult> } {
    const id = nextMutationId();
    if (!frontendReady) {
      // Pre-connect mutations — the bridge retains state and replays on
      // the next `ready`. Treat as success for the awaiter; the ack-bound
      // path is still attached to the outbound message in case the
      // frontend wants to log it, but we don't keep a Promise alive.
      return { id, promise: Promise.resolve({ ok: true }) };
    }
    const promise = new Promise<MutationResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingMutations.has(id)) return;
        pendingMutations.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, MUTATION_ACK_TIMEOUT_MS);
      pendingMutations.set(id, { resolve, timer });
    });
    return { id, promise };
  }

  function ackMutation(id: string, success: boolean, error?: string) {
    const entry = pendingMutations.get(id);
    if (!entry) return;
    pendingMutations.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ ok: !!success, ...(error ? { error } : {}) });
  }

  // Plain functions so methods can call each other without `this` binding
  // ambiguity (extensions sometimes destructure: `const { setState } = aethon`).
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
    // The renderer expects the bare shape. Wrapper-shape templates from
    // existing extensions / older docs are auto-unwrapped here so they
    // continue to work while new templates can use the simpler form.
    let normalized = template;
    if (
      template &&
      typeof template === "object" &&
      !("type" in (template)) &&
      Array.isArray((template as { components?: unknown }).components)
    ) {
      const wrapped = (template as { components: unknown[] }).components;
      if (wrapped.length === 1) normalized = wrapped[0];
    }
    extensionComponents.set(componentType, normalized);
    const { id, promise } = trackMutation();
    send({
      type: "extension_components",
      mutationId: id,
      components: Object.fromEntries(extensionComponents),
    });
    scheduleStateFileWrite();
    return promise;
  }
  function _setState(
    path: string,
    value: unknown,
    sourceTabId?: string,
  ): Promise<MutationResult> {
    if (!path || typeof path !== "string") {
      return Promise.resolve({ ok: false, error: "path required" });
    }
    // tabId attribution priority:
    //   1. explicit sourceTabId (handler-scoped ctx.setState)
    //   2. tabContext.getStore() — per-turn ALS value, propagates through
    //      the agent's async call chain. Both pi prompts AND a2ui_event
    //      handler dispatches now run inside tabContext.run(...), so any
    //      microtask/promise continuation a handler kicks off keeps the
    //      tab attribution. setIntervals registered at module-load time
    //      have NO ALS context — those fall through to (3)/(4).
    //   3. currentAgentTabId — last-known active prompt's tab. Best-effort
    //      for sync code paths that genuinely escape the ALS context.
    //      Documented as "active tab" rather than authoritative; under
    //      concurrent prompts on different tabs this can be wrong.
    //   4. omit tabId — frontend falls back to active. Last resort for
    //      truly tab-less setStates (clock interval registered at boot).
    const attributedTab =
      sourceTabId ?? tabContext.getStore() ?? currentAgentTabId;
    // Per-tab mirrored writes (canvas / messages / draft / waiting /
    // queueCount / model) DON'T belong in the global extensionStateTree
    // — that gets replayed wholesale on `ready` and would smear one
    // tab's state across whichever tab is active after the reload.
    // Instead route them into perTabExtState so each tab's mirrored
    // values can be replayed back into its own record on ready.
    const segs = path.split("/").filter(Boolean);
    const top = segs[0];
    const isMirroredPerTab =
      attributedTab !== undefined &&
      (top === "messages" || top === "draft" || top === "waiting" ||
       top === "queueCount" || top === "canvas" || top === "model");
    if (isMirroredPerTab && attributedTab) {
      const before = perTabExtState.get(attributedTab) ?? {};
      perTabExtState.set(attributedTab, setAtPointer(before, path, value));
    } else {
      extensionStateTree = setAtPointer(extensionStateTree, path, value);
      extensionStateKeys.add(path);
    }
    const { id, promise } = trackMutation();
    send({
      type: "state_patch",
      mutationId: id,
      path,
      value,
      ...(attributedTab ? { tabId: attributedTab } : {}),
    });
    return promise;
  }
  // Pi may re-run extension register() per session, and `tabs` create
  // sessions on demand — so without dedup, every new tab would re-add
  // every extension handler, multiplying side effects on each click.
  // Key by (stringified match + handler source) so a logically identical
  // re-registration is a no-op while truly distinct handlers (different
  // match or different fn body) still register.
  const registeredHandlerKeys = new Set<string>();
  function _onEvent(match: A2UIEventMatch, handler: A2UIEventHandler): void {
    if (typeof handler !== "function") return;
    const key = JSON.stringify(match) + "::" + handler.toString();
    if (registeredHandlerKeys.has(key)) return;
    registeredHandlerKeys.add(key);
    a2uiEventHandlers.push({ match, handler });
    // Refresh the state file so the snapshot reflects newly-wired handlers
    // (their match shape, at least). Was previously omitted and the state
    // file undercounted what the agent could reach via onEvent.
    scheduleStateFileWrite();
  }
  function _setLayout(payload: unknown): Promise<MutationResult> {
    if (!payload || typeof payload !== "object") {
      return Promise.resolve({ ok: false, error: "payload required" });
    }
    extensionLayout = payload;
    // The new layout replaces whatever the pending patches were
    // targeting — drop them so they don't replay against the new tree.
    pendingLayoutPatches = [];
    const { id, promise } = trackMutation();
    send({ type: "layout_set", mutationId: id, payload });
    scheduleStateFileWrite();
    return promise;
  }
  function _patchLayout(path: string, value: unknown): Promise<MutationResult> {
    if (!path || typeof path !== "string") {
      return Promise.resolve({ ok: false, error: "path required" });
    }
    // Apply into the retained extension layout if there is one; otherwise
    // queue against the default layout so reload-replay still applies
    // it. The live frontend gets the same `layout_patch` event either
    // way and folds it via its own array-preserving patcher.
    if (extensionLayout) {
      extensionLayout = patchLayoutTree(extensionLayout, path, value);
    } else {
      pendingLayoutPatches.push({ path, value });
    }
    const { id, promise } = trackMutation();
    send({ type: "layout_patch", mutationId: id, path, value });
    scheduleStateFileWrite();
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
      ((extensionStateTree.sidebar as Record<string, unknown> | undefined)
        ?.extraSections as { id: string }[] | undefined) ?? [];
    const idx = existing.findIndex((s) => s.id === section.id);
    const next = idx >= 0
      ? existing.map((s, i) => (i === idx ? section : s))
      : [...existing, section];
    return _setState("/sidebar/extraSections", next);
  }
  // Register a color scheme. Extension-side, the contract is "give me an
  // id, a label, and a CSS-variable map" — the bridge sanitizes it (see
  // normalizeTheme) and emits a delta. The frontend rebuilds <style> tags
  // from the full list and appends id/label entries to /sidebar/themes
  // alongside the built-in signature item.
  function _registerEventRoute(
    route: unknown,
  ): Promise<MutationResult> {
    if (!route || typeof route !== "object") {
      return Promise.resolve({ ok: false, error: "route required" });
    }
    const obj = route as { componentId?: unknown; eventType?: unknown };
    const componentId =
      typeof obj.componentId === "string" && obj.componentId.trim()
        ? obj.componentId.trim()
        : undefined;
    const eventType =
      typeof obj.eventType === "string" && obj.eventType.trim()
        ? obj.eventType.trim()
        : undefined;
    if (!componentId && !eventType) {
      const errorMsg = "registerEventRoute: at least one of componentId / eventType required";
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const key = `${componentId ?? "*"}:${eventType ?? "*"}`;
    extensionEventRoutes.set(key, {
      ...(componentId ? { componentId } : {}),
      ...(eventType ? { eventType } : {}),
    });
    const list = [...extensionEventRoutes.values()];
    const { id, promise } = trackMutation();
    send({
      type: "extension_event_routes",
      mutationId: id,
      routes: list,
      mode: eventRoutingMode,
    });
    scheduleStateFileWrite();
    return promise;
  }
  function _unregisterEventRoute(route: unknown): Promise<MutationResult> {
    if (!route || typeof route !== "object") {
      return Promise.resolve({ ok: false, error: "route required" });
    }
    const obj = route as { componentId?: unknown; eventType?: unknown };
    const componentId =
      typeof obj.componentId === "string" ? obj.componentId : undefined;
    const eventType =
      typeof obj.eventType === "string" ? obj.eventType : undefined;
    const key = `${componentId ?? "*"}:${eventType ?? "*"}`;
    const had = extensionEventRoutes.delete(key);
    if (!had) return Promise.resolve({ ok: false, error: "no such route" });
    const list = [...extensionEventRoutes.values()];
    const { id, promise } = trackMutation();
    send({
      type: "extension_event_routes",
      mutationId: id,
      routes: list,
      mode: eventRoutingMode,
    });
    scheduleStateFileWrite();
    return promise;
  }
  function _setEventRoutingMode(mode: unknown): Promise<MutationResult> {
    if (mode !== "builtin" && mode !== "extension") {
      const errorMsg = "setEventRoutingMode: mode must be 'builtin' or 'extension'";
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    eventRoutingMode = mode;
    const { id, promise } = trackMutation();
    send({
      type: "extension_event_routes",
      mutationId: id,
      routes: [...extensionEventRoutes.values()],
      mode: eventRoutingMode,
    });
    scheduleStateFileWrite();
    return promise;
  }
  function _listEventRoutes() {
    return [...extensionEventRoutes.values()];
  }
  function _registerMenuItem(
    item: unknown,
  ): Promise<MutationResult> {
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
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    // id defaults to action — callers can override to ship multiple
    // menu items pointing at the same action (e.g. "Run linter" in the
    // app menu AND the tray).
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : action;
    const location: "app" | "tray" =
      obj.location === "tray" ? "tray" : "app";
    const parent = typeof obj.parent === "string" ? obj.parent : undefined;
    extensionMenuItems.set(id, {
      id,
      label,
      action,
      location,
      ...(parent ? { parent } : {}),
    });
    const list = [...extensionMenuItems.values()];
    const { id: mid, promise } = trackMutation();
    send({ type: "extension_menu_items", mutationId: mid, items: list });
    scheduleStateFileWrite();
    return promise;
  }
  function _unregisterMenuItem(id: unknown): Promise<MutationResult> {
    if (typeof id !== "string" || !id.trim()) {
      return Promise.resolve({ ok: false, error: "id required" });
    }
    const had = extensionMenuItems.delete(id.trim());
    if (!had) return Promise.resolve({ ok: false, error: "no such id" });
    const list = [...extensionMenuItems.values()];
    const { id: mid, promise } = trackMutation();
    send({ type: "extension_menu_items", mutationId: mid, items: list });
    scheduleStateFileWrite();
    return promise;
  }
  function canonicalizeCombo(input: string): string {
    const parts = input.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const aliased = parts.map((p) =>
      p === "cmd" || p === "command" ? "meta"
      : p === "control" ? "ctrl"
      : p === "option" ? "alt"
      : p,
    );
    const mods = new Set<string>();
    let key = "";
    for (const p of aliased) {
      if (p === "meta" || p === "ctrl" || p === "alt" || p === "shift") mods.add(p);
      else key = p;
    }
    const ordered = ["meta", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
    return [...ordered, key].filter(Boolean).join("+");
  }
  function _registerKeybinding(
    binding: unknown,
  ): Promise<MutationResult> {
    if (!binding || typeof binding !== "object") {
      return Promise.resolve({ ok: false, error: "binding requires { combo }" });
    }
    const obj = binding as {
      combo?: unknown;
      action?: unknown;
      description?: unknown;
    };
    const combo = typeof obj.combo === "string" ? obj.combo.trim() : "";
    if (!combo) {
      const errorMsg = "registerKeybinding: combo required (e.g. \"Cmd+Shift+P\")";
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const canonical = canonicalizeCombo(combo);
    if (!canonical) {
      const errorMsg = "registerKeybinding: combo must include a key";
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const action = typeof obj.action === "string" && obj.action ? obj.action : canonical;
    const description = typeof obj.description === "string" ? obj.description : undefined;
    extensionKeybindings.set(canonical, {
      combo: canonical,
      action,
      ...(description ? { description } : {}),
    });
    const list = [...extensionKeybindings.values()];
    const { id, promise } = trackMutation();
    send({ type: "extension_keybindings", mutationId: id, bindings: list });
    scheduleStateFileWrite();
    return promise;
  }
  function _unregisterKeybinding(combo: unknown): Promise<MutationResult> {
    if (typeof combo !== "string" || !combo.trim()) {
      return Promise.resolve({ ok: false, error: "combo required" });
    }
    const had = extensionKeybindings.delete(canonicalizeCombo(combo));
    if (!had) {
      return Promise.resolve({ ok: false, error: "no such combo" });
    }
    const list = [...extensionKeybindings.values()];
    const { id, promise } = trackMutation();
    send({ type: "extension_keybindings", mutationId: id, bindings: list });
    scheduleStateFileWrite();
    return promise;
  }
  function _registerSlashCommand(
    cmd: unknown,
  ): Promise<MutationResult> {
    if (!cmd || typeof cmd !== "object") {
      return Promise.resolve({ ok: false, error: "command requires { name }" });
    }
    const obj = cmd as { name?: unknown; description?: unknown; usage?: unknown };
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    // Names are constrained to a slug so they parse as one slash-command
    // token (matches src/slashCommands.ts:parseSlashCommand). Reject
    // collisions with built-ins so an extension can't accidentally
    // shadow /clear, /help, etc. — built-in names checked here against
    // a hardcoded list to stay independent of frontend imports.
    const BUILTIN_SLASH_NAMES = new Set([
      "clear", "help", "theme", "model", "reset", "terminal", "skills",
      "sidebar", "layout", "project",
    ]);
    if (!/^[A-Za-z][\w-]*$/.test(name)) {
      const errorMsg = "registerSlashCommand: name must match /^[A-Za-z][\\w-]*$/";
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    if (BUILTIN_SLASH_NAMES.has(name)) {
      const errorMsg = `registerSlashCommand: "${name}" collides with a built-in command`;
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const description =
      typeof obj.description === "string" ? obj.description : "";
    const usage = typeof obj.usage === "string" ? obj.usage : undefined;
    extensionSlashCommands.set(name, {
      name,
      description,
      ...(usage ? { usage } : {}),
    });
    const list = [...extensionSlashCommands.values()];
    const { id, promise } = trackMutation();
    send({ type: "extension_slash_commands", mutationId: id, commands: list });
    scheduleStateFileWrite();
    return promise;
  }

  // Notifications — agent-pushed toasts. Fire-and-forget by default
  // (the frontend stack auto-dismisses after durationMs); pass an
  // explicit id to drive dismiss programmatically. Visible state lives
  // on the frontend; the bridge doesn't track lifecycle so the state
  // file isn't polluted by transient toasts.
  let _notificationCounter = 0;
  function nextNotificationId(): string {
    _notificationCounter += 1;
    return `n${Date.now().toString(36)}-${_notificationCounter}`;
  }
  function _notify(input: unknown): Promise<MutationResult> {
    if (!input || typeof input !== "object") {
      return Promise.resolve({ ok: false, error: "notify requires { title }" });
    }
    const obj = input as {
      id?: unknown;
      title?: unknown;
      message?: unknown;
      kind?: unknown;
      durationMs?: unknown;
      actions?: unknown;
    };
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!title) {
      const errorMsg = "notify: title required (non-empty string)";
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    const id = typeof obj.id === "string" && obj.id ? obj.id : nextNotificationId();
    const kind =
      obj.kind === "success" || obj.kind === "warning" || obj.kind === "error"
        ? obj.kind
        : "info";
    const message = typeof obj.message === "string" ? obj.message : undefined;
    const durationMs =
      obj.durationMs === null
        ? null
        : typeof obj.durationMs === "number" && Number.isFinite(obj.durationMs)
          ? obj.durationMs
          : undefined;
    let actions:
      | { label: string; action: string }[]
      | undefined;
    if (Array.isArray(obj.actions)) {
      actions = obj.actions
        .filter(
          (a): a is { label: string; action: string } =>
            !!a &&
            typeof a === "object" &&
            typeof (a as { label?: unknown }).label === "string" &&
            typeof (a as { action?: unknown }).action === "string",
        )
        .map((a) => ({ label: a.label, action: a.action }));
      if (actions.length === 0) actions = undefined;
    }
    const notification = {
      id,
      title,
      ...(message ? { message } : {}),
      kind,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(actions ? { actions } : {}),
      createdAt: Date.now(),
    };
    const { id: mid, promise } = trackMutation();
    send({ type: "notification", mutationId: mid, notification });
    // Callers that want to dismiss programmatically should pre-assign
    // an id and pass it back to dismissNotification — keeps the
    // MutationResult shape uniform with the rest of the API.
    return promise;
  }
  function _dismissNotification(id: unknown): Promise<MutationResult> {
    if (typeof id !== "string" || !id) {
      return Promise.resolve({ ok: false, error: "id required" });
    }
    const { id: mid, promise } = trackMutation();
    send({ type: "notification_dismiss", mutationId: mid, id });
    return promise;
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
      // notice (non-terminal) — register failures shouldn't clobber
      // a running prompt's UI state. The Promise carries the same
      // detail for awaiters.
      send({ type: "notice", message: errorMsg });
      return Promise.resolve({ ok: false, error: errorMsg });
    }
    extensionThemes.set(normalized.id, normalized);
    const list = [...extensionThemes.values()];
    const { id, promise } = trackMutation();
    send({ type: "extension_themes", mutationId: id, themes: list });
    scheduleStateFileWrite();
    return promise;
  }

  // Introspection — read-only views over the live state. Lets the agent
  // (and dev-console / debug-eval users) ask "what's loaded?" without
  // scraping the filesystem or guessing from message history. The
  // state file at $AETHON_STATE_FILE has the same data in JSON form.
  function _listExtensions(): { name: string; source: ExtensionSource }[] {
    return [...loadedExtensions.entries()].map(([name, source]) => ({
      name,
      source,
    }));
  }
  function _listComponents(): Record<string, unknown> {
    return Object.fromEntries(extensionComponents);
  }
  function _listThemes(): ThemeRecord[] {
    return [...extensionThemes.values()];
  }
  // Snapshot of the frontend-mirrored state slices. Returns a copy so
  // callers can't mutate the bridge's internal map. Useful for the agent
  // to introspect "what is the UI showing?" without scraping.
  function _getFrontendState(path?: string): unknown {
    if (!path || typeof path !== "string") {
      return Object.fromEntries(frontendState);
    }
    return frontendState.has(path) ? frontendState.get(path) : undefined;
  }
  function _getLayout(): unknown {
    // Return the active rendered tree:
    //   1. extensionLayout if any extension has called setLayout — that's
    //      the live tree and supersedes everything else.
    //   2. otherwise the boot layout with all pendingLayoutPatches folded
    //      in, so an extension inspecting after some patchLayout calls
    //      sees the actual current state, not the pristine boot tree.
    //   3. if the frontend hasn't sent the boot layout yet (very early
    //      startup or a frontend that doesn't speak the protocol), fall
    //      back to null so callers can guard.
    if (extensionLayout) return extensionLayout;
    if (!bootLayout) return null;
    if (pendingLayoutPatches.length === 0) return bootLayout;
    let tree = bootLayout;
    for (const { path, value } of pendingLayoutPatches) {
      tree = patchLayoutTree(tree, path, value);
    }
    return tree;
  }
  function _getRuntimeSnapshot(): RuntimeSnapshot {
    return getRuntimeSnapshot();
  }
  // Layout-slot contract introspection. Returns the canonical slot
  // catalogue shipped by the active default-layout skill (loaded from
  // $AETHON_LAYOUT_SLOTS_FILE at boot). Extensions writing alternative
  // layouts can read this to discover what slot names the standard
  // composites expect, instead of guessing from the layout JSON.
  function _getLayoutSlots(): LayoutSlotsCatalogue | null {
    return layoutSlotsCatalogue ?? null;
  }

  const aethonApi = {
    registerComponent: _registerComponent,
    setState: _setState,
    onEvent: _onEvent,
    setLayout: _setLayout,
    patchLayout: _patchLayout,
    registerSidebarSection: _registerSidebarSection,
    registerTheme: _registerTheme,
    registerSlashCommand: _registerSlashCommand,
    registerKeybinding: _registerKeybinding,
    unregisterKeybinding: _unregisterKeybinding,
    registerMenuItem: _registerMenuItem,
    unregisterMenuItem: _unregisterMenuItem,
    notify: _notify,
    dismissNotification: _dismissNotification,
    registerEventRoute: _registerEventRoute,
    unregisterEventRoute: _unregisterEventRoute,
    listEventRoutes: _listEventRoutes,
    setEventRoutingMode: _setEventRoutingMode,
    listExtensions: _listExtensions,
    listComponents: _listComponents,
    listThemes: _listThemes,
    getLayout: _getLayout,
    getLayoutSlots: _getLayoutSlots,
    getFrontendState: _getFrontendState,
    getRuntimeSnapshot: _getRuntimeSnapshot,
  };
  type AethonApi = typeof aethonApi;
  (globalThis as { aethon?: AethonApi }).aethon = aethonApi;

  // Inject Aethon-awareness into pi's system prompt so the model knows it
  // has a GUI and can mutate `globalThis.aethon` directly. The callback
  // resolves a fresh snapshot every time the resourceLoader is reloaded,
  // so when extensions register components/themes/layouts before a
  // session is created, the resulting system prompt reflects the live
  // state — fixing the previous "agent had no idea what was loaded" bug.
  // User's existing project / global APPEND_SYSTEM.md files are still
  // discovered and preserved; our text is concatenated AFTER theirs so
  // user instructions take precedence. agentDir comes from pi's
  // getAgentDir() so PI_CODING_AGENT_DIR / alternate config dirs work
  // the same way they do for the rest of pi.
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    appendSystemPromptOverride: (base) => [
      ...base,
      ...resolveAethonSystemPrompt(getRuntimeSnapshot()),
    ],
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
  //
  // (TabRecord interface and the `tabs` map are declared near the top
  // of main() so getRuntimeSnapshot can reference them during the
  // initial resourceLoader.reload() that fires before this point.)
  // ---------------------------------------------------------------------

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
  // Persisted per-tab session directories discovered at boot. Shipped
  // in `ready` so the frontend can offer "Recent sessions" in the
  // empty-state composite. Excludes "default" (which the frontend
  // pre-creates anyway). Sorted descending by lastModified.
  let discoveredTabs: { tabId: string; lastModified: number; cwd?: string }[] = [];

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
      // List of paths the bridge currently tracks as extension-owned.
      // Frontend uses the PREVIOUS ready's list as a "stale slice clear"
      // set so an uninstalled extension's leftover state vanishes from
      // local state on the next ready. Live state (chat, draft, etc.)
      // is unaffected since those paths aren't in this set.
      extensionStateKeys: [...extensionStateKeys],
      extensionTabState: Object.fromEntries(perTabExtState),
      extensionLayout,
      extensionLayoutPatches: pendingLayoutPatches,
      extensionThemes: [...extensionThemes.values()],
      extensionSlashCommands: [...extensionSlashCommands.values()],
      extensionKeybindings: [...extensionKeybindings.values()],
      extensionMenuItems: [...extensionMenuItems.values()],
      extensionEventRoutes: [...extensionEventRoutes.values()],
      extensionEventRoutingMode: eventRoutingMode,
      discoveredTabs,
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
  // Sanitize a tabId for use as a directory name on disk. Frontend tab
  // ids are crypto.randomUUID() (hex + hyphens) so the regex below is a
  // no-op for them; the filter exists only as a defense against legacy
  // / external callers passing odd characters. We fall back to a fixed
  // bucket on rejection so the bridge never throws on a malformed id.
  function tabSessionDir(tabId: string): string {
    const safe = /^[A-Za-z0-9_-]{1,128}$/.test(tabId) ? tabId : "_unsafe";
    return join(SESSIONS_DIR, safe);
  }

  // Per-tab project (working directory) the agent operates in. Set by the
  // frontend via `set_project` or as a `cwd` field on `tab_open`. Pi's
  // SessionManager.continueRecent takes the cwd as its first arg — we
  // pass the recorded value here so the session's tool calls (read,
  // bash, write) resolve relative paths against the user's chosen
  // project, not the bridge's spawn directory. Defaults to `undefined`
  // → fall back to `process.cwd()` so out-of-the-box behavior is the
  // same as before any project is picked.
  const tabProjectCwds = new Map<string, string>();

  async function ensureTab(
    tabId: string,
    initialModel?: Model<Api>,
    cwdOverride?: string,
  ): Promise<TabRecord> {
    const existing = tabs.get(tabId);
    if (existing) return existing;

    // Resolve the cwd in priority order: (1) explicit override (passed
    // by tab_open's cwd field), (2) the per-tab record updated by
    // set_project, (3) process.cwd() as the legacy default. Recording
    // (1) into the map after resolution means a later set_project still
    // takes effect on subsequent tabs, while this tab keeps the cwd it
    // was created with — pi sessions cache file paths, so retro-changing
    // cwd would invalidate every cached read.
    const resolvedCwd =
      cwdOverride ?? tabProjectCwds.get(tabId) ?? process.cwd();
    if (cwdOverride) tabProjectCwds.set(tabId, cwdOverride);

    // Persistent per-tab session: the file lives at
    // $AETHON_SESSIONS_DIR/<tabId>/<id>.jsonl. continueRecent picks up
    // the most recent file in that dir and resumes from its leaf — so a
    // bun restart (file watcher, app relaunch) restores the LLM's view
    // of the conversation instead of greeting the user with "I have no
    // context from a previous session". If the dir is empty (new tab),
    // continueRecent silently creates a fresh session.
    let sessionManager;
    try {
      const dir = tabSessionDir(tabId);
      mkdirSync(dir, { recursive: true });
      sessionManager = SessionManager.continueRecent(resolvedCwd, dir);
    } catch (err) {
      console.error(
        `[aethon-session] persistent setup for tab ${tabId} failed (${
          (err as Error).message
        }); falling back to in-memory`,
      );
      sessionManager = SessionManager.inMemory();
    }

    const { session } = await createAgentSession({
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
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
        case "tool_execution_update": {
          if (event.toolName === "bash") {
            let cached = rec.toolArgsCache.get(event.toolCallId);
            if (!cached) {
              cached = {
                name: event.toolName,
                summary: summarizeToolArgs(event.toolName, event.args),
              };
              rec.toolArgsCache.set(event.toolCallId, cached);
            }
            const extracted = extractToolContent(event.partialResult);
            const streamed = consumeBashTerminalSnapshot(
              extracted.text,
              cached.bashStream,
            );
            cached.bashStream = streamed.state;
            emitBashResult(streamed.delta, tabId);
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
            const streamed = consumeBashTerminalSnapshot(
              extracted.text,
              cached?.bashStream,
            );
            emitBashResult(streamed.delta, tabId);
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

  // Load extensions BEFORE creating the default tab so the first
  // session's system prompt reflects what's loaded. Without this, the
  // default tab would see an empty "currently loaded" snapshot until
  // something forced a resourceLoader.reload(), and the agent would
  // give wrong answers to "what extensions are loaded?" on its very
  // first turn (the exact failure the user reported). Failures in one
  // extension don't block others.
  await loadAethonExtensions(aethonApi, loadedExtensions);
  // Project-local Aethon extensions mirror pi's project-local extension
  // pattern. At startup this covers the bridge cwd; later tab_open /
  // set_project messages load extensions for user-selected project cwd values
  // before new sessions are created.
  await loadProjectAethonExtensions(
    process.cwd(),
    aethonApi,
    loadedExtensions,
    loadedProjectExtensionFiles,
  );
  // Discover npm-distributed skill packages (manifest with `aethon` field
  // in package.json) under ~/.aethon/skills/node_modules/. This lets users
  // `npm install --prefix ~/.aethon/skills <pkg>` to install third-party
  // skills that bundle layouts, components, and themes.
  await loadAethonSkillManifests(aethonApi, loadedExtensions);
  // Loose-file themes — JSON in ~/.aethon/themes/*.json registered via the
  // same normalizeTheme path as extension-supplied ones. Lets non-coders
  // share themes without packaging an extension. Hot-reloaded by the same
  // file watcher (~/.aethon/) that picks up extension changes.
  await loadAethonThemeDirectory(aethonApi);
  // Discover pi extensions in ~/.pi/agent/extensions/ that touch
  // globalThis.aethon. Pi loads them itself; we just record their
  // existence so the runtime snapshot covers all UI-driving extensions
  // regardless of source.
  await discoverPiAethonExtensions(loadedExtensions);

  // Refresh the resource loader so the appendSystemPromptOverride
  // callback re-runs against the now-populated extension state. The
  // freshly built system prompt is what the default tab's session
  // captures on createAgentSession.
  await resourceLoader.reload();

  // Pre-create the default tab so emitReady has a populated cachedModels
  // and the frontend can start dispatching to "default" without first
  // racing an ensureTab call.
  await ensureTab("default");

  // Discover persisted per-tab sessions on disk. Surfaces in `ready`
  // so the frontend can populate the empty-state's "Recent sessions"
  // list. Done after ensureTab("default") so the read sees any rolling
  // file the default session just created. The discovery itself doesn't
  // open any of the tabs — they materialize when the user clicks
  // restore-session and the frontend issues a tab_open.
  discoveredTabs = await discoverPersistedTabs();

  // Initial state-file write so `cat $AETHON_STATE_FILE` works before
  // any extension runs a registration. Subsequent registrations
  // schedule their own writes.
  scheduleStateFileWrite();

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
      mutationId?: string;
      success?: boolean;
      error?: string;
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
          // tabContext.run binds `tabId` to the async-local store for
          // the duration of session.prompt's call chain — including any
          // setStates the agent fires from inside it. Concurrent tabs
          // each carry their own store so attribution stays clean.
          tabContext.run(tabId, () =>
            tab.session.prompt(
              msg.content,
              queued ? { streamingBehavior: "followUp" } : undefined,
            ),
          )
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
          //
          // Also drop pi's followUp queue and reset the local counter
          // so the frontend's "waiting while queueCount > 0" gate
          // doesn't keep the Stop button visible after abort.
          const tabId = msg.tabId ?? "default";
          const tab = tabs.get(tabId);
          if (!tab) break; // nothing to stop on a tab we never spun up
          if (typeof (tab.session as { clearQueue?: () => unknown }).clearQueue === "function") {
            try {
              (tab.session as { clearQueue: () => unknown }).clearQueue();
            } catch {
              /* best effort — abort still fires below */
            }
          }
          tab.queuedCount = 0;
          // Tell the frontend so its tab.queueCount matches. Without
          // this, response_end's `if (queueCount > 0) keep waiting`
          // gate would leave the tab stuck on Stop after the abort.
          send({ type: "queue_reset", tabId });
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
          // set_model round-trip. Optional `cwd` scopes pi's session to
          // a user-picked project directory; falls back to process.cwd()
          // when absent.
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
          const cwdField = (msg as { cwd?: unknown }).cwd;
          const cwdOverride =
            typeof cwdField === "string" && cwdField.length > 0
              ? cwdField
              : undefined;
          if (cwdOverride) {
            const loaded = await loadProjectAethonExtensions(
              cwdOverride,
              aethonApi,
              loadedExtensions,
              loadedProjectExtensionFiles,
            );
            if (loaded > 0) {
              await resourceLoader.reload();
              scheduleStateFileWrite();
              emitReady();
            }
          }
          const restoreHistory =
            (msg as { restoreHistory?: unknown }).restoreHistory === true;
          let restoredMessages: Awaited<ReturnType<typeof readSessionTranscript>> = [];
          if (restoreHistory) {
            try {
              restoredMessages = await readSessionTranscript(tabSessionDir(tabId));
            } catch (err) {
              send({
                type: "error",
                tabId,
                message: `session restore: ${(err as Error).message}`,
              });
            }
          }
          await ensureTab(tabId, initialModel, cwdOverride);
          if (restoreHistory) {
            send({ type: "session_history", tabId, messages: restoredMessages });
          }
          break;
        }
        case "set_project": {
          // Frontend tells the bridge which directory to use as cwd for
          // future sessions on the given tab. We don't tear down an
          // already-open session — pi caches file paths against the
          // original cwd, so retro-changing it would orphan cached
          // reads. The next time the tab is recreated (close → reopen,
          // bridge respawn), the new cwd takes effect. cwd === null
          // clears the per-tab override and reverts to process.cwd().
          const tabId = (msg as { tabId?: unknown }).tabId;
          const cwd = (msg as { cwd?: unknown }).cwd;
          if (typeof tabId !== "string" || tabId.length === 0) {
            send({ type: "error", message: "set_project: missing tabId" });
            break;
          }
          if (cwd === null) {
            tabProjectCwds.delete(tabId);
          } else if (typeof cwd === "string" && cwd.length > 0) {
            tabProjectCwds.set(tabId, cwd);
            const loaded = await loadProjectAethonExtensions(
              cwd,
              aethonApi,
              loadedExtensions,
              loadedProjectExtensionFiles,
            );
            if (loaded > 0) {
              await resourceLoader.reload();
              scheduleStateFileWrite();
              emitReady();
            }
          } else {
            send({ type: "error", message: "set_project: cwd must be string|null" });
            break;
          }
          break;
        }
        case "tab_close": {
          // Tear down a tab's session. Aborts any in-flight prompt first
          // so kill signals propagate before we drop the reference.
          //
          // Every tab is closable, including "default" — when the user
          // closes the last open conversation the frontend swaps to the
          // empty-state composite. Bridge's tabs map can be empty too;
          // ensureTab() lazily recreates whatever tab the next inbound
          // message references.
          const tabId = msg.tabId;
          if (!tabId || typeof tabId !== "string") {
            send({ type: "error", message: "tab_close: missing tabId" });
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
          tabProjectCwds.delete(tabId);
          // If we just closed the tab whose turn was "current", clear
          // the global so a stray setState doesn't try to attribute to
          // a tab that no longer exists.
          if (currentAgentTabId === tabId) currentAgentTabId = undefined;
          send({ type: "tab_closed", tabId });
          break;
        }
        case "report": {
          // Frontend has rendered and is ready to ack mutations. Flip the
          // gate so subsequent mutations return Promises that wait for an
          // ack instead of resolving immediately. Pre-report mutations
          // were assumed-ok via retained-state replay.
          frontendReady = true;
          emitReady();
          break;
        }
        case "mutation_ack": {
          // Frontend acknowledges a mutation by id. Resolves the
          // corresponding pending Promise so awaiters unblock.
          const mid = (msg as { mutationId?: unknown }).mutationId;
          const success = (msg as { success?: unknown }).success;
          const errorField = (msg as { error?: unknown }).error;
          if (typeof mid !== "string") break;
          ackMutation(
            mid,
            success === undefined ? true : !!success,
            typeof errorField === "string" ? errorField : undefined,
          );
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
                await tabContext.run(handlerTabId, () =>
                  handlerTab.session.prompt(text),
                );
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                // notice (non-terminal) — must NOT clear the frontend's
                // waiting flag. The handler's own prompt finished/failed,
                // but the surrounding turn (whatever the user actually
                // started) may still be in flight. Sending `error` here
                // would hide the Stop button on that running prompt.
                send({ type: "notice", tabId: handlerTabId, message: `handler prompt: ${m}` });
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
            // Wrap the handler in tabContext.run so any setState the
            // handler fires (or any async chain it kicks off — fetch
            // callbacks, setTimeout, microtask continuations) inherits
            // handlerTabId via AsyncLocalStorage. Without this wrap,
            // _setState would fall back to currentAgentTabId, which is
            // wrong under concurrent prompts on different tabs.
            Promise.resolve()
              .then(() =>
                tabContext.run(handlerTabId, () =>
                  handler(ev, {
                    setState: tabScopedSetState,
                    registerComponent: aethonApi.registerComponent,
                    pi: piCtx,
                  }),
                ),
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
        case "frontend_state_patch": {
          // One-way mirror — frontend pushes a slice value the bridge
          // wouldn't otherwise see (model picker, themes, connection,
          // status, tabs, draft, messagesCount). Bridge stores it under
          // the supplied path so extensions can call
          // `aethon.getFrontendState("/sidebar/models")` for the live
          // value. No ack: this is best-effort mirroring, the next
          // patch supersedes the previous regardless of delivery.
          if (!msg.path || typeof msg.path !== "string") break;
          frontendState.set(msg.path, msg.value);
          // Refresh state file so $AETHON_STATE_FILE reflects the slice
          // change. Debounced 200 ms via the same coalescer that handles
          // registration writes, so a typing burst into the composer
          // doesn't write 60 times/sec.
          scheduleStateFileWrite();
          break;
        }
        case "boot_layout": {
          // Frontend tells the bridge what layout it actually booted with so
          // _getLayout() can return a meaningful tree to extensions inspecting
          // at register-time. Without this, getLayout() returned `null` and
          // extensions that read the current tree to compute a patch silently
          // bailed before doing any work. Sent once on connect and again when
          // the active default-layout skill changes (skill swap → new boot tree).
          if (!msg.payload || typeof msg.payload !== "object") {
            send({ type: "error", message: "boot_layout: missing or invalid payload" });
            break;
          }
          bootLayout = msg.payload;
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
