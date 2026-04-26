/**
 * Aethon agent bridge — JSON-lines over stdio between the Tauri shell and a
 * pi-coding-agent session.
 *
 * Inbound (stdin → bridge):
 *   { "type": "chat", "content": "..." }
 *   { "type": "set_model", "id": "provider/model-id" }
 *   { "type": "a2ui_event", "event": { ... } }   // not yet wired into the agent
 *
 * Outbound (bridge → stdout):
 *   { "type": "ready", "model": "<id>", "models": [{id,label,available}, ...] }
 *   { "type": "response_delta", "content": "..." }
 *   { "type": "response_end" }
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

async function main() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  // Only authed models are switchable from the UI. Always include the
  // current session model even if its provider isn't authed (edge case).
  const availableModels = modelRegistry.getAvailable();
  const seen = new Set(availableModels.map(modelKey));
  if (session.model && !seen.has(modelKey(session.model))) {
    availableModels.unshift(session.model);
  }
  const models = availableModels.map(modelDescriptor);

  const currentModelId = session.model ? modelKey(session.model) : "";
  send({ type: "ready", model: currentModelId, models });

  // Stream text deltas as they arrive; flush an explicit `response_end` when
  // the agent's run settles. The frontend appends deltas to the trailing
  // message, then unsets the waiting flag on response_end.
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta ?? "";
      if (delta) send({ type: "response_delta", content: delta });
    } else if (event.type === "agent_end") {
      send({ type: "response_end" });
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
