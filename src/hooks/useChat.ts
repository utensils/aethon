import {
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "../types/a2ui";
import type { QueuedMessage, Tab } from "../types/tab";
import {
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandContext,
} from "../slashCommands";
import type { NotificationInput } from "./useNotifications";
import { recomputeModelPicker } from "../utils/modelPicker";

/** Patch `queuedMessages` and the derived `queueCount` together so the
 *  composer badge can't drift out of sync with the popover list. */
function withQueue(tab: Tab, next: QueuedMessage[]): Tab {
  return { ...tab, queuedMessages: next, queueCount: next.length };
}

/** Tolerant accessor for tabs that pre-date the field. */
function queueOf(tab: Tab): QueuedMessage[] {
  return tab.queuedMessages ?? [];
}

export interface UseChatContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** From useTabs: routes a per-tab mutation, mirrors active tab to root. */
  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  updateActiveTab: (mutator: (tab: Tab) => Tab) => void;
  /** From useTabs: in-flight tab_open promises sendChat awaits before
   *  send_message so the bridge has the right initial model before the
   *  chat creates the session lazily. */
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  /** From useExtensionsHydration: the merged slash-command list
   *  (built-in + extension). */
  slashCommandsRef: MutableRefObject<SlashCommand[]>;
  /** From useNotifications: surfaces export success/failure. */
  pushNotification: (n: NotificationInput) => string;
  /** Build the live SlashCommandContext for `cmd.run()`. Built per
   *  invocation so handlers see fresh state without re-creating the
   *  command registry. */
  slashContext: () => SlashCommandContext;
  persistLocalChatMessage: (msg: ChatMessage, tabId: string) => void;
  recordProjectModel: (model: string, tabId?: string) => void;
}

export interface UseChatActions {
  /** Fallback id for text bubbles when the bridge doesn't supply one. */
  activeResponseIdRef: MutableRefObject<string | null>;
  /** P4: per-tab turn start timestamps. Set on `prompt_started`,
   *  cleared on `response_end`. Used to compute turn duration for the
   *  OS completion notification gate. */
  turnStartedAtRef: MutableRefObject<Map<string, number>>;

  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  appendOrAmendAgentText: (
    delta: string,
    messageId?: string,
    tabId?: string,
    channel?: "text" | "thinking",
  ) => void;
  appendSystem: (text: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;

  clearChat: () => void;
  sendChat: (
    text: string,
    options?: { mode?: "normal" | "steer"; tabId?: string },
  ) => Promise<void>;
  setModel: (id: string) => Promise<void>;
  stopPrompt: (explicitTabId?: string) => Promise<void>;
  exportActiveChatMarkdown: () => Promise<void>;
  /** Replace the body of a queued message in place. No-op if the id has
   *  already been drained or removed (e.g. a stale popover click). */
  editQueuedMessage: (
    tabId: string,
    messageId: string,
    content: string,
  ) => void;
  /** Drop a queued message before it ships. No-op for unknown ids. */
  deleteQueuedMessage: (tabId: string, messageId: string) => void;
  /** Promote a queued message to a mid-turn steer. Pops it from the queue,
   *  flips `queuedSteeringId` for the popover spinner, then dispatches via
   *  `sendChat(..., { mode: "steer" })`. */
  steerQueuedMessage: (tabId: string, messageId: string) => Promise<void>;
  /** Empty the queue for a tab. */
  clearQueuedMessages: (tabId: string) => void;
}

/**
 * Chat-history mutators + the primary user-driven chat actions
 * (sendChat, setModel, stopPrompt, clearChat, export).
 *
 * Owns:
 *   - `activeResponseIdRef` — fallback bubble id when the bridge
 *     doesn't supply a stable messageId for a streaming agent message.
 *   - `turnStartedAtRef` — per-tab turn-start timestamps used to gate
 *     the OS completion notification on `response_end`.
 *
 * Slash commands route through `parseSlashCommand` + the live
 * `slashCommandsRef`; unknown slashes fall through to the agent so
 * pi's own slash command handling stays reachable. `//foo` escapes
 * to force a literal `/foo` to be sent.
 */
export function useChat(ctx: UseChatContext): UseChatActions {
  const {
    setState,
    stateRef,
    updateTab,
    updateActiveTab,
    pendingTabOpens,
    slashCommandsRef,
    pushNotification,
    slashContext,
    persistLocalChatMessage,
    recordProjectModel,
  } = ctx;

  // Fallback id for text bubbles when the bridge doesn't supply one. The
  // bridge now sends a stable `messageId` per pi assistant message so text
  // deltas after a tool card still land in the original bubble; this ref
  // only matters for old-bridge / legacy `response_delta` payloads.
  const activeResponseIdRef = useRef<string | null>(null);
  // P4: per-tab turn start timestamps. Set on `prompt_started`, cleared
  // on `response_end`. Used to compute turn duration for the OS
  // completion notification gate.
  const turnStartedAtRef = useRef<Map<string, number>>(new Map());

  // Append a chat message, or replace in place if a message with the same
  // id already exists. This is what lets the bridge stream "running…" tool
  // cards and update them with the final result without duplicating bubbles.
  // tabId routes to the right tab record; defaults to the active tab so
  // legacy callers that pre-date the multi-tab refactor stay correct.
  function appendMessage(msg: ChatMessage, tabId?: string) {
    const id =
      tabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        messages[idx] = msg;
      } else {
        messages.push(msg);
      }
      return { ...tab, messages };
    });
  }

  // Append a streaming text delta to its bubble. When the bridge supplies a
  // stable `messageId` (one per pi assistant message), look up the bubble by
  // id anywhere in the array — this keeps text from a single agent message in
  // one bubble even after tool cards land between deltas. Without a messageId
  // (legacy bridges), fall back to the previous "is it the last message?"
  // behavior tracked via activeResponseIdRef.
  function appendOrAmendAgentText(
    delta: string,
    messageId?: string,
    tabId?: string,
    channel: "text" | "thinking" = "text",
  ) {
    const id =
      tabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    updateTab(id, (tab) => {
      const messages = [...tab.messages];
      if (messageId) {
        const idx = messages.findIndex((m) => m.id === messageId);
        let nextMessage: ChatMessage;
        if (idx >= 0) {
          nextMessage = {
            ...messages[idx],
            [channel]: (messages[idx][channel] ?? "") + delta,
          };
          messages[idx] = nextMessage;
        } else {
          nextMessage = { id: messageId, role: "agent", [channel]: delta };
          messages.push(nextMessage);
        }
        activeResponseIdRef.current = messageId;
        persistLocalChatMessage(nextMessage, id);
        return { ...tab, messages };
      }
      const activeId = activeResponseIdRef.current;
      const last = messages[messages.length - 1];
      if (activeId && last && last.id === activeId && last.role === "agent") {
        const nextMessage = {
          ...last,
          [channel]: (last[channel] ?? "") + delta,
        };
        messages[messages.length - 1] = nextMessage;
        persistLocalChatMessage(nextMessage, id);
      } else {
        const newId = crypto.randomUUID();
        activeResponseIdRef.current = newId;
        const nextMessage = { id: newId, role: "agent" as const, [channel]: delta };
        messages.push(nextMessage);
        persistLocalChatMessage(nextMessage, id);
      }
      return { ...tab, messages };
    });
  }

  function setStatusFlags(
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) {
    setState((prev) => ({ ...prev, ...flags }));
  }

  function appendSystem(text: string) {
    appendMessage({ id: crypto.randomUUID(), role: "system", text });
  }

  function clearChat() {
    // Clears the active tab's in-memory message list. Pi's JSONL file is
    // managed by the session itself; clearing chat here only affects the UI
    // view for this session slot. The agent will continue writing new turns
    // to the same session file, so a restart still sees prior history — this
    // is intentional (Cmd+K is a "clean view" action, not a "delete history"
    // action). If the user wants to start fresh, they open a new tab.
    updateActiveTab((tab) => ({ ...tab, messages: [] }));
  }

  async function stopPrompt(explicitTabId?: string) {
    const tabId =
      explicitTabId ??
      (stateRef.current.activeTabId as string | undefined) ??
      "default";
    // The composer's Stop button advertises "Stop + clear" when the
    // queue is non-empty; clear the client-held queue here so a user
    // who stopped because they wanted *out* of the train can't have
    // the next queued message drain on the following idle.
    updateTab(tabId, (tab) =>
      tab.queuedMessages.length === 0 ? tab : withQueue(tab, []),
    );
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "stop", tabId }),
      });
      setStatusFlags({ status: "stopping…" });
    } catch (err) {
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to stop: ${err}`,
        },
        tabId,
      );
    }
  }

  async function sendChat(
    text: string,
    options?: { mode?: "normal" | "steer"; tabId?: string },
  ) {
    const trimmed = text.trim();
    if (!trimmed) return;

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
        };
        appendMessage(slashUserMessage, slashTabId);
        persistLocalChatMessage(slashUserMessage, slashTabId);
        // Clear via updateActiveTab — without this, the active tab's
        // draft still holds the slash text and any subsequent mirror
        // (clearChat, theme switch, …) writes it back into root.draft,
        // making the input "stick".
        updateActiveTab((tab) => ({ ...tab, draft: "" }));
        try {
          await cmd.run(parsed.args, slashContext());
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
    const mode = options?.mode === "steer" ? "steer" : "normal";
    const tabId = explicitTabId ?? activeTabId ?? "default";
    const targetTab = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
      (tab) => tab.id === tabId,
    );
    const wasBusy =
      targetTab?.waiting === true ||
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
        content: sendText,
      };
      updateTab(tabId, (tab) => withQueue(tab, [...queueOf(tab), entry]));
      // Clear the draft on the originating tab so the textarea empties
      // even though we didn't ship the message. Mirrors the normal-send
      // behavior below.
      updateTab(tabId, (tab) => ({ ...tab, draft: "" }));
      return;
    }

    const delivery: ChatMessage["delivery"] =
      mode === "steer" && wasBusy ? "steered" : "sent";
    const userMessageId = crypto.randomUUID();
    const userMessage = {
      id: userMessageId,
      role: "user" as const,
      text: sendText,
      delivery,
    };
    appendMessage(userMessage, tabId);
    updateTab(tabId, (tab) => ({ ...tab, draft: "", waiting: true }));
    setState((prev) =>
      prev.activeTabId === tabId
        ? {
            ...prev,
            status: "thinking…",
            connection: "connected",
          }
        : prev,
    );

    // Wait for any pending tab_open on this tab to land first so the
    // bridge has the right initial model before the chat creates the
    // session lazily. swallow any open errors — sendChat surfaces its
    // own error path below.
    const pending = pendingTabOpens.current.get(tabId);
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore */
      }
    }
    persistLocalChatMessage(userMessage, tabId);
    const targetCwd =
      typeof targetTab?.cwd === "string" && targetTab.cwd.length > 0
        ? targetTab.cwd
        : undefined;
    try {
      await invoke("send_message", {
        message: sendText,
        tabId,
        mode,
        ...(targetCwd ? { cwd: targetCwd } : {}),
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

  async function setModel(id: string) {
    const tabId =
      (stateRef.current.activeTabId as string | undefined) ?? "default";
    const previousModel = (stateRef.current.model as string | undefined) ?? "";
    const canOptimisticallyMirror = stateRef.current.waiting !== true;
    recordProjectModel(id, tabId);
    if (canOptimisticallyMirror) {
      updateTab(tabId, (tab) => ({ ...tab, model: id }));
      setState((prev) => ({
        ...prev,
        model: id,
        status: `switching to ${id}...`,
        sidebar: recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          id,
        ),
      }));
    }
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "set_model", id, tabId }),
      });
    } catch (err) {
      if (previousModel && canOptimisticallyMirror) {
        updateTab(tabId, (tab) => ({ ...tab, model: previousModel }));
        setState((prev) => ({
          ...prev,
          model: previousModel,
          status: "model switch failed",
          sidebar: recomputeModelPicker(
            prev.sidebar as Record<string, unknown> | undefined,
            previousModel,
          ),
        }));
      }
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch model: ${err}`,
        },
        tabId,
      );
    }
  }

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
    const header = `# ${tab.label}\n\n_Exported from Aethon · ${new Date().toISOString()}_\n\n`;
    try {
      const path = await invoke<string>("export_chat_markdown", {
        label: tab.label,
        content: header + body,
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

  function editQueuedMessage(
    tabId: string,
    messageId: string,
    content: string,
  ) {
    updateTab(tabId, (tab) => {
      const current = queueOf(tab);
      if (current.length === 0) return tab;
      const idx = current.findIndex((m) => m.id === messageId);
      if (idx < 0) return tab;
      const next = current.slice();
      next[idx] = { ...next[idx], content };
      return withQueue(tab, next);
    });
  }

  function deleteQueuedMessage(tabId: string, messageId: string) {
    updateTab(tabId, (tab) => {
      const current = queueOf(tab);
      if (current.length === 0) return tab;
      const next = current.filter((m) => m.id !== messageId);
      if (next.length === current.length) return tab;
      return withQueue(tab, next);
    });
  }

  function clearQueuedMessages(tabId: string) {
    updateTab(tabId, (tab) => {
      if (queueOf(tab).length === 0) return tab;
      return withQueue(tab, []);
    });
  }

  async function steerQueuedMessage(tabId: string, messageId: string) {
    const tab = ((stateRef.current.tabs as Tab[] | undefined) ?? []).find(
      (t) => t.id === tabId,
    );
    if (!tab) return;
    const entry = queueOf(tab).find((m) => m.id === messageId);
    if (!entry) return;
    // Pop the message from the queue and flip the spinner id in one render
    // commit so the popover row replaces itself with the spinner instead
    // of briefly showing nothing.
    updateTab(tabId, (t) => ({
      ...withQueue(
        t,
        queueOf(t).filter((m) => m.id !== messageId),
      ),
      queuedSteeringId: messageId,
    }));
    try {
      await sendChat(entry.content, { mode: "steer", tabId });
    } finally {
      updateTab(tabId, (t) =>
        t.queuedSteeringId === messageId
          ? { ...t, queuedSteeringId: undefined }
          : t,
      );
    }
  }

  return {
    activeResponseIdRef,
    turnStartedAtRef,
    appendMessage,
    appendOrAmendAgentText,
    appendSystem,
    setStatusFlags,
    clearChat,
    sendChat,
    setModel,
    stopPrompt,
    exportActiveChatMarkdown,
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
  };
}
