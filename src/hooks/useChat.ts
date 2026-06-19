import {
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment, ChatMessage } from "../types/a2ui";
import type { QueuedMessage, Tab } from "../types/tab";
import {
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandContext,
} from "../slashCommands";
import type { NotificationInput } from "./useNotifications";
import {
  recomputeModelPicker,
  PI_DEFAULT_MODEL_SENTINEL,
} from "../utils/modelPicker";
import { getConfig, clearConfigCache, type AethonConfig } from "../config";
import {
  hydrateAgentActivityState,
  type AgentDiagnosticRow,
} from "./useAgentActivityHydration";
import { isAgentTabInFlight } from "../utils/agentBusy";

const STOP_CONFIRM_DELAYS_MS = [0, 150, 500, 1000, 2000] as const;
/** Patch `queuedMessages` and the derived `queueCount` together so the
 *  composer badge can't drift out of sync with the popover list. */
function withQueue(tab: Tab, next: QueuedMessage[]): Tab {
  return { ...tab, queuedMessages: next, queueCount: next.length };
}

/** Tolerant accessor for tabs that pre-date the field. */
function queueOf(tab: Tab): QueuedMessage[] {
  return tab.queuedMessages ?? [];
}

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parseModelIdWithThinking(raw: string): {
  modelId: string;
  thinkingLevel?: string;
} {
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return { modelId: raw };
  const modelId = raw.slice(0, idx);
  const suffix = raw.slice(idx + 1);
  if (!modelId.startsWith("openai-codex/") || !THINKING_LEVELS.has(suffix)) {
    return { modelId: raw };
  }
  return { modelId, thinkingLevel: suffix };
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
  findTabById?: (tabId: string) => Tab | undefined;
  /** pi's boot/default model, used as the new-tab fallback. Cleared when
   *  the user resets to "(pi default)" so the next new session sends no
   *  explicit model and the agent picks its env-driven default. */
  piDefaultModelRef: MutableRefObject<string>;
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
    options?: {
      mode?: "normal" | "steer";
      tabId?: string;
      attachments?: ChatAttachment[];
      bridgeText?: string;
    },
  ) => Promise<void>;
  setModel: (id: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setCodexFastMode: (enabled: boolean) => Promise<void>;
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
    findTabById,
    piDefaultModelRef,
  } = ctx;

  // Fallback id for text bubbles when the bridge doesn't supply one. The
  // bridge sends a stable `messageId` for the active streamed assistant
  // segment and rolls it at tool boundaries so later deltas do not amend an
  // earlier bubble above intervening tool cards. This ref only matters for
  // old-bridge / legacy `response_delta` payloads.
  const activeResponseIdRef = useRef<string | null>(null);
  // P4: per-tab turn start timestamps. Set on `prompt_started`, cleared
  // on `response_end`. Used to compute turn duration for the OS
  // completion notification gate.
  const turnStartedAtRef = useRef<Map<string, number>>(new Map());

  // Debounced persistence of header-selected agent defaults to [agent].
  // Clicking through models / reasoning levels would otherwise do a disk read +
  // full TOML rewrite per click; coalesce to a single trailing write.
  const agentDefaultsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAgentDefaultsRef = useRef<
    Partial<{ model: string | null; thinkingLevel: string | null }>
  >({});

  async function flushAgentDefaultsWrite() {
    const patch = pendingAgentDefaultsRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingAgentDefaultsRef.current = {};
    let live: AethonConfig | null = null;
    try {
      live = await getConfig();
    } catch {
      /* fall through with nulls — write_config seeds a fresh document */
    }
    // write_config is whole-config destructive: it removes keys it does
    // not see and always re-emits [shell] default_share_mode. Merge the
    // full live config before writing, mirroring the Settings save path
    // (uiOverlays/settings.ts) so unrelated sections survive the round-trip.
    const merged = {
      ui: { ...(live?.ui ?? {}) },
      agent: { ...(live?.agent ?? {}), ...patch },
      shell: { ...(live?.shell ?? {}) },
      shortcuts: { ...(live?.shortcuts ?? {}) },
      voice: { ...(live?.voice ?? {}) },
      updates: { ...(live?.updates ?? {}) },
      devshell: { ...(live?.devshell ?? {}) },
      guardrails: { ...(live?.guardrails ?? {}) },
    };
    try {
      await invoke("write_config", { config: merged });
      // Drop the read-once cache so an open Settings panel + the next
      // getConfig() reflect the header-chosen defaults.
      clearConfigCache();
    } catch (err) {
      console.warn("persist agent defaults failed:", err);
    }
  }

  function persistAgentDefaults(
    patch: Partial<{ model: string | null; thinkingLevel: string | null }>,
  ) {
    pendingAgentDefaultsRef.current = {
      ...pendingAgentDefaultsRef.current,
      ...patch,
    };
    if (agentDefaultsTimerRef.current) {
      clearTimeout(agentDefaultsTimerRef.current);
    }
    agentDefaultsTimerRef.current = setTimeout(() => {
      agentDefaultsTimerRef.current = null;
      void flushAgentDefaultsWrite();
    }, 400);
  }

  function persistDefaultModel(model: string) {
    persistAgentDefaults({ model: model || null });
  }

  function persistDefaultThinkingLevel(level: string) {
    persistAgentDefaults({ thinkingLevel: level || null });
  }

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
      } else if (typeof msg.createdAt === "number") {
        const insertAt = messages.findIndex(
          (m) =>
            typeof m.createdAt === "number" && m.createdAt > msg.createdAt!,
        );
        if (insertAt >= 0) {
          messages.splice(insertAt, 0, msg);
        } else {
          messages.push(msg);
        }
      } else {
        messages.push(msg);
      }
      return { ...tab, messages };
    });
  }

  // Append a streaming text delta to its bubble. When the bridge supplies a
  // stable `messageId`, look up the bubble by id anywhere in the array —
  // this keeps deltas for one streamed assistant segment in one bubble while
  // allowing the bridge to start a fresh bubble after tool cards. Without a
  // messageId (legacy bridges), fall back to the previous "is it the last message?"
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
            createdAt: messages[idx].createdAt ?? Date.now(),
            [channel]: (messages[idx][channel] ?? "") + delta,
          };
          messages[idx] = nextMessage;
        } else {
          nextMessage = {
            id: messageId,
            role: "agent",
            createdAt: Date.now(),
            [channel]: delta,
          };
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
          createdAt: last.createdAt ?? Date.now(),
          [channel]: (last[channel] ?? "") + delta,
        };
        messages[messages.length - 1] = nextMessage;
        persistLocalChatMessage(nextMessage, id);
      } else {
        const newId = crypto.randomUUID();
        activeResponseIdRef.current = newId;
        const nextMessage = {
          id: newId,
          role: "agent" as const,
          createdAt: Date.now(),
          [channel]: delta,
        };
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
    appendMessage({
      id: crypto.randomUUID(),
      role: "system",
      text,
      createdAt: Date.now(),
    });
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

  function diagnosticMatchesTab(row: AgentDiagnosticRow, tabId: string) {
    return (
      row.tab_id === tabId ||
      row.tabId === tabId ||
      row.key === `tab:${tabId}` ||
      (tabId === "default" && row.key === "__global__")
    );
  }

  async function confirmPromptStopped(tabId: string) {
    for (const delay of STOP_CONFIRM_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      let diagnostics: AgentDiagnosticRow[];
      try {
        const result = await invoke<AgentDiagnosticRow[]>("agent_diagnostics");
        if (!Array.isArray(result)) return;
        diagnostics = result;
      } catch {
        return;
      }
      const row = diagnostics.find((entry) =>
        diagnosticMatchesTab(entry, tabId),
      );
      if (!row) continue;
      const promptInFlight =
        row.prompt_in_flight === true || row.promptInFlight === true;
      if (row.alive !== false && promptInFlight) continue;
      const stoppedMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "system",
        text: "Agent stopped.",
        createdAt: Date.now(),
      };
      setState((prev) => {
        const hydrated = hydrateAgentActivityState(prev, diagnostics, {
          trustNegativeDiagnosticsForTabIds: new Set([tabId]),
          closeStaleToolCardsForTabIds: new Set([tabId]),
        });
        const tabs = (hydrated.tabs as Tab[] | undefined) ?? [];
        const nextTabs = tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, messages: [...tab.messages, stoppedMessage] }
            : tab,
        );
        return hydrated.activeTabId === tabId
          ? {
              ...hydrated,
              status: "stopped",
              messages: [
                ...((hydrated.messages as ChatMessage[]) ?? []),
                stoppedMessage,
              ],
              tabs: nextTabs,
            }
          : { ...hydrated, tabs: nextTabs };
      });
      return;
    }
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
      await confirmPromptStopped(tabId);
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
    options?: {
      mode?: "normal" | "steer";
      tabId?: string;
      attachments?: ChatAttachment[];
      bridgeText?: string;
    },
  ) {
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
    const targetModel =
      typeof targetTab?.model === "string" && targetTab.model.length > 0
        ? targetTab.model
        : typeof stateRef.current.model === "string" &&
            stateRef.current.model.length > 0
          ? stateRef.current.model
          : undefined;
    const targetThinkingLevel =
      typeof targetTab?.thinkingLevel === "string" &&
      targetTab.thinkingLevel.length > 0
        ? targetTab.thinkingLevel
        : typeof stateRef.current.thinkingLevel === "string" &&
            stateRef.current.thinkingLevel.length > 0
          ? stateRef.current.thinkingLevel
        : undefined;
    const targetPlanMode =
      targetTab?.kind === "agent" ? targetTab.planMode === true : false;
    try {
      await invoke("send_message", {
        request: {
          message: bridgeText,
          tabId,
          mode,
          planMode: targetPlanMode,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(targetCwd ? { cwd: targetCwd } : {}),
          ...(targetModel ? { model: targetModel } : {}),
          ...(targetThinkingLevel
            ? { thinkingLevel: targetThinkingLevel }
            : {}),
          ...(typeof targetTab?.hardEnforceProjectRoot === "boolean"
            ? { hardEnforce: targetTab.hardEnforceProjectRoot }
            : {}),
          // Carry the tab's account so a freshly (re)spawned worker resolves
          // the right profile instead of falling back to the provider
          // default (which could be the account the user switched away from).
          ...(targetTab?.authProfileId
            ? { authProfileId: targetTab.authProfileId }
            : {}),
        },
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

  /** Header / Settings model pick. Two responsibilities:
   *
   *  1. Set the user's default model for *new* sessions — `/defaultModel`,
   *     persisted to `[agent] model`. This always sticks; it is intent,
   *     independent of whether a live session accepts the switch, and wins
   *     over per-project memory in `modelForNewProjectTab`.
   *  2. Retarget the *active* session (when one is focused) via `set_model`.
   *
   *  With no active agent tab (e.g. on the dashboard) we skip the bridge
   *  call entirely — there is nothing to switch and invoking `set_model`
   *  would spin up a phantom "default" session — but the default pick above
   *  is enough for the next new session to inherit. */
  async function setModel(id: string) {
    // "(pi default)" — fully reset to pi's env-driven default for new
    // sessions. Clear every runtime fallback so the next new tab sends
    // NO explicit model and the agent picks from env: the chosen default
    // (/defaultModel), per-project memory (/projectModels), and pi's
    // cached boot model (/piDefaultModel + piDefaultModelRef — which may
    // itself be a stale configured value seeded at boot). Persist
    // [agent] model = null. Does not retarget a running session — the
    // reset governs new sessions only, matching the old Settings field.
    if (id === PI_DEFAULT_MODEL_SENTINEL) {
      const activeId = stateRef.current.activeTabId as string | undefined;
      const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      const activeTab = activeId
        ? tabs.find((t) => t.id === activeId)
        : undefined;
      const hasActiveAgentTab = activeTab?.kind === "agent";
      piDefaultModelRef.current = "";
      setState((prev) => ({
        ...prev,
        defaultModel: "",
        piDefaultModel: "",
        projectModels: {},
        // Blank the header display when no agent tab owns it so the picker
        // shows "(pi default)"; a focused session keeps its own model.
        ...(hasActiveAgentTab ? {} : { model: "" }),
        sidebar: recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          hasActiveAgentTab ? (activeTab?.model ?? "") : "",
        ),
      }));
      persistDefaultModel(""); // writes [agent] model = null
      return;
    }
    const parsed = parseModelIdWithThinking(id.trim());
    const trimmed = parsed.modelId;
    if (!trimmed) return;
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = activeId
      ? tabs.find((t) => t.id === activeId)
      : undefined;
    const hasActiveAgentTab = activeTab?.kind === "agent";
    const previousTabModel = activeTab?.model ?? "";
    // Only mirror onto a live session when an agent tab is focused and not
    // mid-turn (the bridge rejects a switch while a prompt is in flight).
    const canMirror =
      hasActiveAgentTab &&
      stateRef.current.waiting !== true &&
      !isAgentTabInFlight(activeTab);

    recordProjectModel(trimmed, activeId);
    setState((prev) => ({
      ...prev,
      defaultModel: trimmed,
      ...(parsed.thinkingLevel
        ? {
            thinkingLevel: parsed.thinkingLevel,
            defaultThinkingLevel: parsed.thinkingLevel,
          }
        : {}),
      // Mirror onto /model for the header display when we're switching a
      // live session OR when no agent tab owns the header (dashboard /
      // shell focus) so the picker reflects the chosen default. When an
      // agent tab is busy we leave /model alone — the switch is deferred.
      ...(canMirror || !hasActiveAgentTab ? { model: trimmed } : {}),
      ...(canMirror ? { status: `switching to ${trimmed}...` } : {}),
      sidebar: recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        trimmed,
      ),
    }));
    if (canMirror && activeId) {
      updateTab(activeId, (tab) => ({ ...tab, model: trimmed }));
    }
    persistDefaultModel(trimmed);
    if (parsed.thinkingLevel) {
      persistDefaultThinkingLevel(parsed.thinkingLevel);
    }

    // No live session to retarget — the default pick is all that's needed.
    if (!hasActiveAgentTab || !activeId) return;
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({
          type: "set_model",
          id: trimmed,
          tabId: activeId,
          ...(parsed.thinkingLevel
            ? { thinkingLevel: parsed.thinkingLevel }
            : {}),
        }),
      });
    } catch (err) {
      // Roll back ONLY the optimistic live-session mirror — the chosen
      // default (/defaultModel + persisted config) is intent and stays.
      if (canMirror && previousTabModel) {
        updateTab(activeId, (tab) => ({ ...tab, model: previousTabModel }));
        setState((prev) => ({
          ...prev,
          model: previousTabModel,
          status: "model switch failed",
        }));
      }
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch model: ${err}`,
        },
        activeId,
      );
    }
  }

  async function setThinkingLevel(level: string) {
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeTab = activeId
      ? tabs.find((t) => t.id === activeId)
      : undefined;
    if (!activeId || (activeTab?.kind ?? "agent") !== "agent") {
      setState((prev) => ({
        ...prev,
        thinkingLevel: level,
        defaultThinkingLevel: level,
        status: `reasoning default: ${level}`,
      }));
      persistDefaultThinkingLevel(level);
      return;
    }
    if (stateRef.current.waiting === true || isAgentTabInFlight(activeTab)) {
      setState((prev) => ({
        ...prev,
        status:
          "agent busy — stop the current prompt before switching reasoning",
      }));
      return;
    }
    const previousTabThinkingLevel = activeTab?.thinkingLevel;
    const previousThinkingLevel =
      typeof stateRef.current.thinkingLevel === "string"
        ? stateRef.current.thinkingLevel
        : undefined;
    updateTab(activeId, (tab) => ({ ...tab, thinkingLevel: level }));
    setState((prev) => ({
      ...prev,
      thinkingLevel: level,
      defaultThinkingLevel: level,
      status: `reasoning: ${level}`,
    }));
    persistDefaultThinkingLevel(level);
    try {
      await invoke("agent_command", {
        payload: JSON.stringify({
          type: "set_thinking_level",
          tabId: activeId,
          thinkingLevel: level,
        }),
      });
    } catch (err) {
      updateTab(activeId, (tab) => {
        const next = { ...tab };
        if (previousTabThinkingLevel) {
          next.thinkingLevel = previousTabThinkingLevel;
        } else {
          delete next.thinkingLevel;
        }
        return next;
      });
      setState((prev) => {
        const next: Record<string, unknown> = {
          ...prev,
          status: "reasoning switch failed",
        };
        if (previousThinkingLevel) {
          next.thinkingLevel = previousThinkingLevel;
        } else {
          delete next.thinkingLevel;
        }
        // Keep defaultThinkingLevel as the user's new-session default; only
        // the active live-session mirror rolls back on bridge failure.
        return next;
      });
      appendMessage(
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: `Failed to switch reasoning: ${err}`,
        },
        activeId,
      );
    }
  }

  async function setCodexFastMode(enabled: boolean) {
    const previousCodexFastMode = stateRef.current.codexFastMode === true;
    setState((prev) => ({ ...prev, codexFastMode: enabled }));
    let live: AethonConfig | null = null;
    try {
      try {
        live = await getConfig();
      } catch {
        /* fall through with defaults */
      }
      const merged = {
        ui: { ...(live?.ui ?? {}) },
        agent: { ...(live?.agent ?? {}), codexFastMode: enabled },
        shell: { ...(live?.shell ?? {}) },
        shortcuts: { ...(live?.shortcuts ?? {}) },
        voice: { ...(live?.voice ?? {}) },
        updates: { ...(live?.updates ?? {}) },
        devshell: { ...(live?.devshell ?? {}) },
        guardrails: { ...(live?.guardrails ?? {}) },
      };
      await invoke("write_config", { config: merged });
      clearConfigCache();
      await invoke("agent_broadcast_command", {
        payload: JSON.stringify({
          type: "set_codex_fast_mode",
          codexFastMode: enabled,
        }),
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        codexFastMode: previousCodexFastMode,
        status: "Codex Fast mode update failed",
      }));
      appendMessage({
        id: crypto.randomUUID(),
        role: "agent",
        text: `Failed to update Codex Fast mode: ${err}`,
      });
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
      // Drop any hidden bridge text: a user-rewritten body supersedes the
      // original @file expansion, so dispatch exactly what they now see.
      next[idx] = { ...next[idx], content, bridgeText: undefined };
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
      await sendChat(entry.content, {
        mode: "steer",
        tabId,
        attachments: entry.attachments,
        ...(entry.bridgeText ? { bridgeText: entry.bridgeText } : {}),
      });
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
    setThinkingLevel,
    setCodexFastMode,
    stopPrompt,
    exportActiveChatMarkdown,
    editQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    clearQueuedMessages,
  };
}
