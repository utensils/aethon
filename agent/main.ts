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
 *
 * Outbound (bridge → stdout):
 *   { "type": "ready", "model": "<id>", "models": [{id,label,available}, ...],
 *     "extensionComponents": {<componentType>: <template>, ...} }
 *      // Snapshot of currently-registered extension templates, sent on every
 *      // ready emission so a webview reload picks them up without losing
 *      // state.
 *   { "type": "extension_components", "components": {<componentType>: <template>, ...} }
 *      // Emitted after each registration delta; frontend hydrates templates
 *      // into the SkillRegistry.
 *   { "type": "state_patch", "path": "/foo", "value": <any> }
 *      // Forward of an extension's set_state call. Frontend applies via
 *      // JSON Pointer.
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
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createInterface } from "node:readline";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function modelKey(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
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

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
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

  // Aethon-specific extension UI registry. Pi extensions can register A2UI
  // component templates and push state via the `aethon` API exposed below.
  // Templates are plain A2UI subtrees keyed by component type; the frontend
  // wraps each as a synthetic React component in the SkillRegistry so that
  // `{type: "<componentType>"}` in any A2UI tree expands the template inline.
  const extensionComponents = new Map<string, unknown>();

  function emitReady() {
    const currentModelId = session.model ? modelKey(session.model) : "";
    send({
      type: "ready",
      model: currentModelId,
      models,
      extensionComponents: Object.fromEntries(extensionComponents),
    });
  }

  // Aethon-side extension API. Loaded extensions get an instance via the
  // `aethon` namespace (see loadAethonExtensions below). All registrations
  // also work via stdin commands so external tools / debug skills can drive
  // the same surface.
  const aethonApi = {
    registerComponent(componentType: string, template: unknown): void {
      if (!componentType || typeof componentType !== "string") return;
      extensionComponents.set(componentType, template);
      send({
        type: "extension_components",
        components: Object.fromEntries(extensionComponents),
      });
    },
    setState(path: string, value: unknown): void {
      if (!path || typeof path !== "string") return;
      send({ type: "state_patch", path, value });
    },
  };
  type AethonApi = typeof aethonApi;

  // Discover Aethon extensions in `~/.aethon/extensions/*.ts` and call their
  // `register(api)` default export. Failures in one extension don't block
  // others — log and continue so a broken extension can't take the agent
  // down at boot.
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
          // Reserved for skill/tool routing — accept silently for now so the
          // frontend's optimistic dispatch doesn't error.
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
