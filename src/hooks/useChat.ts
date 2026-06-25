import {
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import type { SlashCommand, SlashCommandContext } from "../slashCommands";
import type { NotificationInput } from "./useNotifications";
import { useChatMessageController } from "./chatMessages";
import {
  createChatTransportController,
  type SendChatOptions,
} from "./chatTransport";
import { useChatModelSelectionController } from "./chatModelSelection";
import { createStopPromptController } from "./stopPrompt";
import { createChatExportController } from "./chatExport";
import { createChatQueueController } from "./chatQueue";

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
  slashContext: (options?: {
    afterCreatedAt?: number;
    tabId?: string;
  }) => SlashCommandContext;
  persistLocalChatMessage: (
    msg: ChatMessage,
    tabId: string,
  ) => Promise<boolean>;
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
    model?: string,
  ) => void;
  appendSystem: (text: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;

  clearChat: () => void;
  sendChat: (text: string, options?: SendChatOptions) => Promise<void>;
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
 * Public chat composition hook. Behavior lives in focused controllers:
 * message history, transport, model selection, stop handling, export, and
 * queue operations.
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

  const messages = useChatMessageController(ctx, activeResponseIdRef);
  const transport = createChatTransportController(ctx, messages);
  const modelSelection = useChatModelSelectionController(ctx, messages);
  const stop = createStopPromptController(ctx, messages);
  const chatExport = createChatExportController(ctx);
  const queue = createChatQueueController(ctx, transport.sendChat);

  return {
    activeResponseIdRef,
    turnStartedAtRef,
    ...messages,
    ...transport,
    ...modelSelection,
    ...stop,
    ...chatExport,
    ...queue,
  };
}
