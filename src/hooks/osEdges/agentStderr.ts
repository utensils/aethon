import { listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "../../types/a2ui";

export interface AgentStderrDeps {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  persistLocalChatMessage: (
    msg: ChatMessage,
    tabId: string,
  ) => Promise<boolean>;
}

export function tabIdFromAgentStderr(text: string): string | undefined {
  return /\btabId=([A-Za-z0-9_-]+)/.exec(text)?.[1];
}

export function createdAtFromAgentStderr(text: string): number | undefined {
  const raw = /^(\d{4}-\d{2}-\d{2}T[^\s]+)/.exec(text)?.[1];
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Mirror agent stderr into chat as a system message. When the bridge
 *  dies on startup this is the only signal we have.
 *
 *  Two filter tiers to avoid spamming the feed:
 *  1. Bridge log lines tagged WARN / ERROR / FATAL (the bun logger
 *     writes `<ISO> LEVEL scope: msg`). INFO/DEBUG are ignored so
 *     noisy progress lines like `… load took 0ms (loaded=0 failed=0)`
 *     don't pop into chat just because they contain "fail".
 *  2. Raw uncaught throws / panics / module-resolution errors that
 *     escape the logger entirely — matched by anchor or well-known
 *     prefixes, not loose substrings.
 *
 *  `ext-state:` lines are extension feedback (size-guard rejections,
 *  etc.) and stay in bridge logs only; surfacing them to chat would
 *  spam when an extension misbehaves on a setInterval. */
export function subscribeAgentStderr(deps: AgentStderrDeps): () => void {
  const { appendMessage, persistLocalChatMessage } = deps;

  const unlistenStderr = listen<string>("agent-stderr", (event) => {
    const text = event.payload?.toString().trim();
    if (!text) return;
    const isLeveledFailure = /\b(WARN|ERROR|FATAL)\b/.test(text);
    const isRawCrash =
      /^(Error|TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|panic:)/i.test(
        text,
      ) ||
      /\bthrow\s+new\s|\bCannot\s+find\s+(module|package)\b|\bEACCES\b|\bENOENT\b/i.test(
        text,
      );
    const isExtensionNoise = /\b(WARN|INFO)\s+ext-state:/.test(text);
    if ((isLeveledFailure || isRawCrash) && !isExtensionNoise) {
      const tabId = tabIdFromAgentStderr(text) ?? "default";
      const chatMessage = {
        id: crypto.randomUUID(),
        role: "system" as const,
        text: `[agent stderr] ${text}`,
        createdAt: createdAtFromAgentStderr(text),
      };
      appendMessage(chatMessage, tabId);
      persistLocalChatMessage(chatMessage, tabId);
    }
    // Always log to webview console for debug skill access.
    console.warn("[agent stderr]", text);
  });

  return () => {
    unlistenStderr.then((fn) => fn());
  };
}
