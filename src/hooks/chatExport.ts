import { invoke } from "@tauri-apps/api/core";

import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import type { UseChatContext } from "./useChat";

export function buildChatMarkdown(
  label: string,
  messages: ChatMessage[],
  exportedAt = new Date(),
): string {
  const body = messages
    .map((m) => {
      const heading = `### ${m.role}`;
      const text = (m.text ?? "").replace(/\r\n/g, "\n").trim();
      const thinking = (m.thinking ?? "").replace(/\r\n/g, "\n").trim();
      const thinkingBlock = thinking
        ? `<thinking>\n${thinking}\n</thinking>\n\n`
        : "";
      return `${heading}\n\n${thinkingBlock}${text}\n`;
    })
    .join("\n");
  const header = `# ${label}\n\n_Exported from Aethon · ${exportedAt.toISOString()}_\n\n`;
  return header + body;
}

export interface ChatExportController {
  exportActiveChatMarkdown: () => Promise<void>;
}

export function createChatExportController(
  ctx: Pick<UseChatContext, "stateRef" | "pushNotification">,
): ChatExportController {
  const { stateRef, pushNotification } = ctx;

  /** Cmd+Shift+S: export the active agent tab's chat history as a
   *  Markdown file in ~/Downloads/. Shell tabs no-op (no chat
   *  history). The body uses GitHub-flavored Markdown — role labels
   *  as `### user` / `### assistant`, message text as paragraphs. */
  async function exportActiveChatMarkdown() {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
    if (!tab || tab.kind !== "agent") {
      pushNotification({
        id: "ae-export-no-chat",
        title: "Nothing to export",
        message: "Switch to an agent tab to export its chat as Markdown.",
        kind: "info",
        durationMs: 2400,
      });
      return;
    }
    const messages = tab.messages ?? [];
    if (messages.length === 0) {
      pushNotification({
        id: "ae-export-empty",
        title: "Empty chat",
        message: "There are no messages to export yet.",
        kind: "info",
        durationMs: 2400,
      });
      return;
    }
    try {
      const path = await invoke<string>("export_chat_markdown", {
        label: tab.label,
        content: buildChatMarkdown(tab.label, messages),
      });
      pushNotification({
        id: "ae-export-saved",
        title: "Chat exported",
        message: `Saved to ${path}`,
        kind: "success",
        durationMs: 3000,
      });
    } catch (err) {
      pushNotification({
        id: "ae-export-failed",
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
        durationMs: 4000,
      });
    }
  }

  return { exportActiveChatMarkdown };
}
