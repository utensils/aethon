import { invoke } from "@tauri-apps/api/core";

import type { ChatAttachment, ChatMessage } from "../types/a2ui";
import type { QueuedMessage, Tab } from "../types/tab";
import { parseSlashCommand } from "../slashCommands";
import { isAgentTabInFlight } from "../utils/agentBusy";
import { flushDeferredTabOpen } from "./bridgeMessageHandlers/readyEffects";
import { queueOf, withQueue } from "./chatQueue";
import type { UseChatContext } from "./useChat";

export interface SendChatOptions {
  mode?: "normal" | "steer";
  tabId?: string;
  attachments?: ChatAttachment[];
  bridgeText?: string;
  controlRequestId?: string;
}

export interface SendMessageRequest {
  message: string;
  tabId: string;
  mode: "normal" | "steer";
  planMode: boolean;
  attachments?: ChatAttachment[];
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
  suppressUserSessionEvent: boolean;
  hardEnforce?: boolean;
  authProfileId?: string;
  controlRequestId?: string;
}

export interface BuildSendMessageRequestParams {
  message: string;
  tabId: string;
  mode: "normal" | "steer";
  attachments: ChatAttachment[];
  targetTab: Tab | undefined;
  state: Record<string, unknown>;
  suppressUserSessionEvent: boolean;
  controlRequestId?: string;
}

export function buildSendMessageRequest({
  message,
  tabId,
  mode,
  attachments,
  targetTab,
  state,
  suppressUserSessionEvent,
  controlRequestId,
}: BuildSendMessageRequestParams): SendMessageRequest {
  const targetCwd =
    typeof targetTab?.cwd === "string" && targetTab.cwd.length > 0
      ? targetTab.cwd
      : undefined;
  const targetModel =
    typeof targetTab?.model === "string" && targetTab.model.length > 0
      ? targetTab.model
      : typeof state.model === "string" && state.model.length > 0
        ? state.model
        : undefined;
  const targetThinkingLevel =
    typeof targetTab?.thinkingLevel === "string" &&
    targetTab.thinkingLevel.length > 0
      ? targetTab.thinkingLevel
      : typeof state.thinkingLevel === "string" &&
          state.thinkingLevel.length > 0
        ? state.thinkingLevel
        : undefined;
  const targetPlanMode =
    targetTab?.kind === "agent" ? targetTab.planMode === true : false;

  return {
    message,
    tabId,
    mode,
    planMode: targetPlanMode,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(targetCwd ? { cwd: targetCwd } : {}),
    ...(targetModel ? { model: targetModel } : {}),
    ...(targetThinkingLevel ? { thinkingLevel: targetThinkingLevel } : {}),
    suppressUserSessionEvent,
    ...(typeof targetTab?.hardEnforceProjectRoot === "boolean"
      ? { hardEnforce: targetTab.hardEnforceProjectRoot }
      : {}),
    // Carry the tab's account so a freshly (re)spawned worker resolves
    // the right profile instead of falling back to the provider
    // default (which could be the account the user switched away from).
    ...(targetTab?.authProfileId
      ? { authProfileId: targetTab.authProfileId }
      : {}),
    ...(controlRequestId ? { controlRequestId } : {}),
  };
}

export interface ChatTransportDeps {
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendSystem: (text: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
}

export interface ChatTransportController {
  sendChat: (text: string, options?: SendChatOptions) => Promise<void>;
}

export function createChatTransportController(
  ctx: Pick<
    UseChatContext,
    | "setState"
    | "stateRef"
    | "updateTab"
    | "updateActiveTab"
    | "pendingTabOpens"
    | "slashCommandsRef"
    | "slashContext"
    | "persistLocalChatMessage"
    | "findTabById"
  >,
  deps: ChatTransportDeps,
): ChatTransportController {
  const {
    setState,
    stateRef,
    updateTab,
    updateActiveTab,
    pendingTabOpens,
    slashCommandsRef,
    slashContext,
    persistLocalChatMessage,
    findTabById,
  } = ctx;
  const { appendMessage, appendSystem, setStatusFlags } = deps;

  async function sendChat(text: string, options?: SendChatOptions) {
    const trimmed = text.trim();
    const attachments = options?.attachments ?? [];
    if (!trimmed && attachments.length === 0) return;

    const activeTabId = stateRef.current.activeTabId as string | undefined;
    const explicitTabId = options?.tabId;

    // Client-side slash commands handle UI-only actions (clear, theme, etc.).
    // Unknown slash commands fall through to the agent so pi's own slash
    // command handling and any prompt-template / skill commands still reach
    // it. `//foo` escapes to force a literal `/foo` to be sent.
    const parsed = parseSlashCommand(trimmed);
    if (parsed) {
      const cmd = slashCommandsRef.current.find((c) => c.name === parsed.name);
      // Client slash contexts are active-tab oriented today. If a caller
      // explicitly targets a different tab, do not echo into that tab while
      // mutating the active one; pass the slash through to the target agent
      // instead. Active-tab sends keep the existing local-command behavior.
      const canRunLocalSlash = !explicitTabId || explicitTabId === activeTabId;
      if (cmd && !cmd.passthroughToAgent && canRunLocalSlash) {
        const slashTabId = activeTabId ?? "default";
        const slashUserMessage = {
          id: crypto.randomUUID(),
          role: "user" as const,
          text: trimmed,
          createdAt: Date.now(),
        };
        appendMessage(slashUserMessage, slashTabId);
        persistLocalChatMessage(slashUserMessage, slashTabId);
        // Clear via updateActiveTab — without this, the active tab's
        // draft still holds the slash text and any subsequent mirror
        // (clearChat, theme switch, …) writes it back into root.draft,
        // making the input "stick".
        updateActiveTab((tab) => ({
          ...tab,
          draft: "",
          draftAttachments: [],
        }));
        try {
          await cmd.run(
            parsed.args,
            slashContext({
              afterCreatedAt: slashUserMessage.createdAt,
              tabId: slashTabId,
            }),
          );
        } catch (err) {
          appendSystem(`Slash command \`/${parsed.name}\` failed: ${err}`);
        }
        return;
      }
      // Unknown or explicitly non-active target — fall through to
      // send_message. Pi's own command handling on the agent side may pick it
      // up; if not, the LLM sees the literal text.
    }

    const sendText = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    const displayText =
      sendText.length > 0
        ? sendText
        : attachments.length === 1
          ? "Please inspect the attached image."
          : "Please inspect the attached images.";
    const bridgeText = options?.bridgeText?.trim() || displayText;
    const mode = options?.mode === "steer" ? "steer" : "normal";
    const tabId = explicitTabId ?? activeTabId ?? "default";
    const targetTab =
      findTabById?.(tabId) ??
      ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
        (tab) => tab.id === tabId,
      );
    const wasBusy =
      isAgentTabInFlight(targetTab) ||
      ((targetTab === undefined || tabId === activeTabId) &&
        stateRef.current.waiting === true);

    // Client-side queue: a normal-mode submit while the agent is busy lands
    // in `tab.queuedMessages` instead of going to the bridge. The popover
    // above the composer renders the list, lets the user edit / delete /
    // promote-to-steer each entry, and `useQueuedDispatch` drains the head
    // on the next idle. Skipping history here is intentional — Claudette
    // shows queued items only in the popover, then they enter history as
    // normal user bubbles once the auto-drain fires.
    if (
      mode === "normal" &&
      wasBusy &&
      targetTab !== undefined &&
      targetTab.kind === "agent"
    ) {
      const entry: QueuedMessage = {
        id: crypto.randomUUID(),
        // Store the visible body for the popover/history; carry the hidden
        // dispatch text separately so expanded @file context never surfaces
        // in the queue UI or becomes editable.
        content: displayText,
        ...(bridgeText !== displayText ? { bridgeText } : {}),
        attachments,
      };
      updateTab(tabId, (tab) => withQueue(tab, [...queueOf(tab), entry]));
      // Clear the draft on the originating tab so the textarea empties
      // even though we didn't ship the message. Mirrors the normal-send
      // behavior below.
      updateTab(tabId, (tab) => ({
        ...tab,
        draft: "",
        draftAttachments: [],
      }));
      return;
    }

    const delivery: ChatMessage["delivery"] =
      mode === "steer" && wasBusy ? "steered" : "sent";
    const userMessageId = crypto.randomUUID();
    const userMessage = {
      id: userMessageId,
      role: "user" as const,
      text: displayText,
      ...(attachments.length > 0 ? { attachments } : {}),
      delivery,
      createdAt: Date.now(),
    };
    appendMessage(userMessage, tabId);
    updateTab(tabId, (tab) => ({
      ...tab,
      draft: "",
      draftAttachments: [],
      waiting: true,
    }));
    setState((prev) =>
      prev.activeTabId === tabId
        ? {
            ...prev,
            status: "thinking…",
            connection: "connected",
          }
        : prev,
    );

    // A deferred restored tab opens on this first interaction (lazy
    // replay — see readyEffects.ts); otherwise wait for any pending
    // tab_open so the bridge has the right initial model before the
    // chat creates the session lazily. Swallow any open errors —
    // sendChat surfaces its own error path below.
    const pending =
      flushDeferredTabOpen(tabId) ?? pendingTabOpens.current.get(tabId);
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore */
      }
    }
    const userSessionEventMirrored = await persistLocalChatMessage(
      userMessage,
      tabId,
    );
    try {
      await invoke("send_message", {
        request: buildSendMessageRequest({
          message: bridgeText,
          tabId,
          mode,
          attachments,
          targetTab,
          state: stateRef.current,
          suppressUserSessionEvent: userSessionEventMirrored,
          controlRequestId: options?.controlRequestId,
        }),
      });
    } catch (err) {
      updateTab(tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((message) =>
          message.id === userMessageId
            ? { ...message, delivery: "failed" as const }
            : message,
        ),
      }));
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Connection error: ${err}`,
        },
        tabId,
      );
      updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
      if (stateRef.current.activeTabId === tabId)
        setStatusFlags({ status: "error" });
    }
  }

  return { sendChat };
}
