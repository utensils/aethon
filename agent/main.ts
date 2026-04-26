/**
 * Aethon agent bridge — reads JSON lines from stdin, forwards to pi,
 * streams responses back as JSON lines on stdout.
 *
 * Protocol:
 *   stdin  → { "type": "chat", "content": "..." }
 *   stdout ← { "type": "response", "content": "...", "done": false }
 *   stdout ← { "type": "response", "content": "", "done": true }
 *   stdout ← { "type": "error", "message": "..." }
 */

import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const SYSTEM_PROMPT = `You are Aethon, a helpful coding assistant running inside a native desktop shell. Be concise and direct.`;

function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  // Create a pi agent session
  const session = await createAgentSession({
    systemPrompt: SYSTEM_PROMPT,
    // pi-ai reads provider config from env vars:
    // ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, etc.
  });

  // Read JSON lines from stdin
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: { type: string; content: string };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ type: "error", message: "invalid JSON" });
      continue;
    }

    if (msg.type !== "chat" || !msg.content) {
      send({ type: "error", message: "expected {type:'chat', content:'...'}" });
      continue;
    }

    try {
      // Stream the response
      const response = await session.prompt(msg.content);

      // For now, send the full response as one chunk
      // TODO: wire up streaming events when pi SDK supports it
      send({ type: "response", content: response ?? "", done: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "error", message });
    }
  }
}

main().catch((err) => {
  send({ type: "error", message: `fatal: ${err.message ?? err}` });
  process.exit(1);
});
