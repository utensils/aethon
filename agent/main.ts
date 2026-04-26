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
 *
 * Outbound (bridge → stdout):
 *   { "type": "ready", "model": "<id>", "models": [{id,label,available}, ...] }
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

  function emitReady() {
    const currentModelId = session.model ? modelKey(session.model) : "";
    send({ type: "ready", model: currentModelId, models });
  }

  emitReady();

  // Cache tool args from start so we can include them in the end-state card
  // (tool_execution_end doesn't carry args).
  const toolArgsCache = new Map<string, { name: string; summary: string }>();

  // Per-tool streaming state. We track the cumulative byte position we last
  // forwarded from `partialResult.text`. The common case is monotonic growth
  // (pi accumulates), in which case `slice(sent)` is the new suffix.
  // If `fullText.length` shrinks below `sent`, upstream has rolled to a
  // tail-window — we emit a one-time "[…possible gap]" banner and re-emit
  // whatever the current payload holds. This may duplicate the most recent
  // bytes but never silently drops a delta (which the previous tail-match
  // approach did for repeated identical chunks).
  const TERMINAL_MAX_BYTES = 64 * 1024;
  const TERMINAL_CHUNK_BYTES = 8 * 1024;

  const bashSentBytes = new Map<string, number>();
  const bashGapWarned = new Set<string>();

  function emitTerminalText(text: string): void {
    if (!text) return;
    const normalized = text.replace(/\r?\n/g, "\r\n");
    for (let i = 0; i < normalized.length; i += TERMINAL_CHUNK_BYTES) {
      send({
        type: "terminal_output",
        content: normalized.slice(i, i + TERMINAL_CHUNK_BYTES),
      });
    }
  }

  function streamBashOutputDelta(callId: string, fullText: string): void {
    if (!fullText) return;
    const sent = bashSentBytes.get(callId) ?? 0;
    let suffix: string;
    if (fullText.length < sent) {
      // Upstream rolled past what we've seen.
      if (!bashGapWarned.has(callId)) {
        bashGapWarned.add(callId);
        send({
          type: "terminal_output",
          content: `\r\n[…possible gap in bash stream — upstream rolled past prior output]\r\n`,
        });
      }
      suffix = fullText;
    } else if (fullText.length === sent) {
      return;
    } else {
      suffix = fullText.slice(sent);
    }
    if (suffix.length > TERMINAL_MAX_BYTES) {
      suffix = suffix.slice(suffix.length - TERMINAL_MAX_BYTES);
      if (!bashGapWarned.has(callId)) {
        bashGapWarned.add(callId);
        send({
          type: "terminal_output",
          content: `\r\n[…single delta truncated to last ${TERMINAL_MAX_BYTES} bytes]\r\n`,
        });
      }
    }
    emitTerminalText(suffix);
    bashSentBytes.set(callId, fullText.length);
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
      case "tool_execution_update": {
        // Stream partial bash output as it arrives so long-running commands
        // (test runs, installs) are visible in the terminal panel before
        // they exit. Only the new bytes are forwarded each tick.
        if (event.toolName === "bash") {
          const extracted = extractToolContent(event.partialResult);
          if (extracted.text) {
            streamBashOutputDelta(event.toolCallId, extracted.text);
          }
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
          // Forward only the suffix that wasn't already streamed via
          // tool_execution_update events.
          streamBashOutputDelta(event.toolCallId, extracted.text);
          send({ type: "terminal_output", content: "\r\n" });
          bashSentBytes.delete(event.toolCallId);
          bashGapWarned.delete(event.toolCallId);
        }
        toolArgsCache.delete(event.toolCallId);
        break;
      }
      case "agent_end": {
        send({ type: "response_end" });
        break;
      }
    }
  });

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: { type: string; content?: string; id?: string };
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
          await session.prompt(msg.content);
          break;
        }
        case "set_model": {
          if (!msg.id) {
            send({ type: "error", message: "set_model: missing id" });
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
          // session.abort() resolves once the agent settles to idle; the
          // existing agent_end → response_end path then flips /waiting.
          await session.abort();
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
