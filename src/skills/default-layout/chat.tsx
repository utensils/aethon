/**
 * Chat composites for the default-layout skill — `ChatHistory`,
 * `ChatInput` (with the slash-command palette), `ToolCard` (live
 * elapsed-time clock for agent tool calls), and the `MainCanvas` host
 * that pairs message history with a live-rendered A2UI subtree.
 */

import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type {
  A2UIComponent,
  BooleanValue,
  ChatMessage,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";
import A2UIRenderer from "../../components/A2UIRenderer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { useSkillRegistry } from "../../skills/SkillRegistry";
import type { QueuedMessage } from "../../types/tab";
import { useStickyScroll } from "../../utils/useStickyScroll";
import { MARKDOWN_COMPONENTS } from "./markdown-adapter";
import { readUiScale } from "./layout";

// ---------------------------------------------------------------------------
// ToolCard — agent tool-call card with live elapsed-time clock (M6 P4).
//
// Replaces the plain `card` primitive for tool-call rendering so we can:
//   - Show "Running… 3.2s" while the tool is executing (4 Hz updates)
//   - Shift the title amber + add "Long-running command" hint at 30 s
//   - Show "Completed in 12.4s" on natural finish, "Failed in 2.1s" on error
//
// Props match the bridge's existing toolCardPayload shape, with two new
// timestamps. The bridge emits `startedAt` on tool_execution_start and
// `endedAt` on tool_execution_end; if `endedAt` is omitted while
// `startedAt` is set, the card is still running.
// ---------------------------------------------------------------------------

const TOOL_LONG_RUN_THRESHOLD_MS = 30 * 1000;
const DRAFT_COMMIT_DELAY_MS = 80;
const INITIAL_VISIBLE_MESSAGES = 160;
const MESSAGE_PAGE_SIZE = 120;

// eslint-disable-next-line react-refresh/only-export-components -- exported for vitest unit tests; doesn't affect HMR semantics in practice
export function formatToolDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

// Status icons for tool card pill
function ToolStatusIcon({
  running,
  isError,
  isCancelled,
  isLongRunning,
}: {
  running: boolean;
  isError: boolean;
  isCancelled: boolean;
  isLongRunning: boolean;
}) {
  if (running) {
    const label = isLongRunning ? "Tool long-running" : "Tool running";
    return (
      <span
        role="img"
        aria-label={label}
        className={`ae-tool-status-icon ae-tool-status-running${isLongRunning ? " ae-tool-status-long" : ""}`}
      >
        <span className="ae-tool-spinner" aria-hidden="true" />
      </span>
    );
  }
  if (isError || isCancelled) {
    const className = isCancelled
      ? "ae-tool-status-icon ae-tool-status-cancelled"
      : "ae-tool-status-icon ae-tool-status-error";
    return (
      <span
        role="img"
        aria-label={isCancelled ? "Tool cancelled" : "Tool failed"}
        className={className}
      >
        <span aria-hidden="true">✕</span>
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label="Tool completed"
      className="ae-tool-status-icon ae-tool-status-done"
    >
      <span aria-hidden="true">✓</span>
    </span>
  );
}

export function ToolCard({
  component,
  state,
  renderChildren,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    description?: StringValue;
    /** epoch ms — when the tool started executing. */
    startedAt?: NumberValue;
    /** epoch ms — when the tool finished. Omit while running. */
    endedAt?: NumberValue;
    isError?: BooleanValue;
    /** Tool name shown in the title; argsSummary as the description. */
    toolName?: StringValue;
    /** Terminal state synthesized by the bridge when a turn is aborted. */
    status?: StringValue;
  };
  const baseTitle = props.title ? resolveString(props.title, state) : "";
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const startedAt = props.startedAt
    ? resolveNumber(props.startedAt, state)
    : undefined;
  const endedAt = props.endedAt
    ? resolveNumber(props.endedAt, state)
    : undefined;
  const isError = props.isError ? resolveBoolean(props.isError, state) : false;
  const status = props.status ? resolveString(props.status, state) : undefined;
  const isCancelled = status === "cancelled";
  const running = startedAt !== undefined && endedAt === undefined;

  // Tick at 4 Hz while running so the clock stays smooth without
  // thrashing. The interval is cleared on unmount AND on the
  // running→done transition so cards in chat history don't keep
  // timers alive forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(handle);
  }, [running]);

  const elapsedMs = useMemo(() => {
    if (startedAt === undefined) return 0;
    if (endedAt !== undefined) return Math.max(0, endedAt - startedAt);
    return Math.max(0, now - startedAt);
  }, [startedAt, endedAt, now]);

  const isLongRunning = running && elapsedMs >= TOOL_LONG_RUN_THRESHOLD_MS;
  const hasChildren = (component.children?.length ?? 0) > 0;

  const timeSuffix = useMemo(() => {
    if (running) return formatToolDuration(elapsedMs);
    if (startedAt === undefined) return "";
    const duration = formatToolDuration(elapsedMs);
    if (isCancelled) return `Cancelled in ${duration}`;
    if (isError) return `Failed in ${duration}`;
    return `Completed in ${duration}`;
  }, [running, startedAt, elapsedMs, isCancelled, isError]);

  return (
    <details
      className="ae-tool-card"
      data-running={running ? "true" : "false"}
      data-long-running={isLongRunning ? "true" : "false"}
      data-error={isError ? "true" : "false"}
      data-cancelled={isCancelled ? "true" : "false"}
    >
      <summary className="ae-tool-card-summary">
        <ToolStatusIcon
          running={running}
          isError={isError}
          isCancelled={isCancelled}
          isLongRunning={isLongRunning}
        />
        <span className="ae-tool-card-name">{baseTitle}</span>
        {description && (
          <span className="ae-tool-card-description">{description}</span>
        )}
        {timeSuffix && <span className="ae-tool-card-time">{timeSuffix}</span>}
        {isLongRunning && (
          <span className="ae-tool-card-long-hint">
            long-running · <kbd>⌘.</kbd> to stop
          </span>
        )}
      </summary>
      <div className="ae-tool-card-body">
        {hasChildren ? (
          renderChildren?.()
        ) : (
          <div className="ae-tool-card-empty">No output</div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// TypingIndicator — animated three-dot pulse shown while the agent is thinking
// (waiting=true but no streaming tokens yet).
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div
      role="status"
      aria-label="Agent is thinking"
      className="ae-typing-indicator"
    >
      <span className="ae-typing-dot" aria-hidden="true" />
      <span className="ae-typing-dot" aria-hidden="true" />
      <span className="ae-typing-dot" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScrollToBottomPill — shown when the user has scrolled up. Uses position:sticky
// so it sits inside the scrollable flex container without absolute positioning.
// ---------------------------------------------------------------------------

function ScrollToBottomPill({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      className="a2ui-scroll-to-bottom"
      onClick={onClick}
      aria-label="Scroll to latest message"
    >
      ↓ latest
    </button>
  );
}

// ---------------------------------------------------------------------------
// ChatHistory — scrollable message feed with sticky-follow auto-scroll.
// Messages can be plain text or embedded A2UI subtrees (rendered recursively).
// ---------------------------------------------------------------------------

function roleBadge(role: string): string {
  if (role === "user") return "YOU";
  if (role === "agent") return "AI";
  return "SYS";
}

function deliveryLabel(delivery: ChatMessage["delivery"]): string | null {
  switch (delivery) {
    case "queued":
      return "queued";
    case "steered":
      return "steered";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function queuedDeliveryLabels(messages: ChatMessage[]): Map<string, string> {
  const queued = messages.filter(
    (message) => message.role === "user" && message.delivery === "queued",
  );
  if (queued.length <= 1) return new Map();
  return new Map(
    queued.map((message, index) => [message.id, `queued #${index + 1}`]),
  );
}

function ThinkingBlock({
  children,
  complete = true,
}: {
  children: string;
  complete?: boolean;
}) {
  const label = complete ? "Thinking" : "Thinking...";
  return (
    <details className="a2ui-thinking-block" open={!complete}>
      <summary>{label}</summary>
      <div className="a2ui-thinking-content a2ui-markdown">
        <ReactMarkdown components={MARKDOWN_COMPONENTS}>
          {children}
        </ReactMarkdown>
      </div>
    </details>
  );
}

function MarkdownWithThinking({ text }: { text: string }) {
  return (
    <>
      {splitThinkingBlocks(text).map((segment, index) => {
        if (!segment.content) return null;
        if (segment.type === "thinking") {
          return (
            <ThinkingBlock key={index} complete={segment.closed !== false}>
              {segment.content}
            </ThinkingBlock>
          );
        }
        return (
          <ReactMarkdown key={index} components={MARKDOWN_COMPONENTS}>
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </>
  );
}

const MemoMarkdownWithThinking = memo(MarkdownWithThinking);

const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    state,
    tabId,
    className = "a2ui-chat-message",
    prevRole,
    onEvent,
    deliveryText,
  }: {
    message: ChatMessage;
    state: Record<string, unknown>;
    tabId?: string;
    className?: string;
    prevRole?: string;
    onEvent?: BuiltinComponentProps["onEvent"];
    deliveryText?: string;
  }) {
    const isCanvas = className === "a2ui-canvas-message";
    const roleClass = isCanvas ? "a2ui-canvas-role" : "a2ui-chat-role";
    const textClass = isCanvas
      ? "a2ui-canvas-text a2ui-markdown"
      : "a2ui-chat-text a2ui-markdown";
    // Suppress role label for consecutive messages from same sender
    const showRole = prevRole !== message.role;
    const delivery =
      message.role === "user"
        ? (deliveryText ?? deliveryLabel(message.delivery))
        : null;
    return (
      <div
        className={`${className} ${message.role}${showRole ? "" : " ae-msg-cont"}`}
      >
        {message.role !== "system" && (showRole || delivery) && (
          <span className="a2ui-chat-meta">
            {showRole && (
              <span className={roleClass}>{roleBadge(message.role)}</span>
            )}
            {delivery && (
              <span
                className={`a2ui-chat-delivery a2ui-chat-delivery-${delivery}`}
              >
                {delivery}
              </span>
            )}
            {delivery === "failed" && message.text && onEvent && (
              <button
                type="button"
                className="a2ui-chat-retry"
                onClick={() =>
                  onEvent("retry", {
                    messageId: message.id,
                    value: message.text,
                  })
                }
              >
                Retry
              </button>
            )}
          </span>
        )}
        {message.thinking && (
          <ThinkingBlock complete={Boolean(message.text)}>
            {message.thinking}
          </ThinkingBlock>
        )}
        {message.text && (
          <div className={textClass}>
            <MemoMarkdownWithThinking text={message.text} />
          </div>
        )}
        {message.a2ui && (
          <A2UIRenderer payload={message.a2ui} state={state} tabId={tabId} />
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.tabId === next.tabId &&
    prev.className === next.className &&
    prev.prevRole === next.prevRole &&
    prev.onEvent === next.onEvent &&
    prev.deliveryText === next.deliveryText &&
    (!next.message.a2ui || prev.state === next.state),
);

export function ChatHistory({
  component,
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };

  const listRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(listRef);

  const messages = useMemo(
    () => (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [],
    [props.messages.$ref, state],
  );
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  );
  const queuedLabels = useMemo(() => queuedDeliveryLabels(messages), [messages]);
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);
  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "Start a conversation.";

  // Search-hit restore: scroll to the matching message and flash it.
  // Driven by `state.scrollToMatchByTab[tabId]` — App.tsx populates
  // this on search-result click and clears it after 5 s.
  const scrollToMatchByTab =
    (state.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
  const scrollToMatch = tabId ? scrollToMatchByTab[tabId] : undefined;

  const prevScrollToMatch = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !scrollToMatch || scrollToMatch === prevScrollToMatch.current)
      return;
    prevScrollToMatch.current = scrollToMatch;
    const needle = scrollToMatch.toLowerCase();
    const idx = messages.findIndex((m) =>
      (m.text ?? "").toLowerCase().includes(needle),
    );
    if (idx >= 0) {
      const start = Math.max(0, messages.length - visibleCount);
      if (idx < start) {
        window.setTimeout(() => {
          setVisibleCount(messages.length - idx);
          const row = el.querySelectorAll(".a2ui-chat-message")[0];
          if (row instanceof HTMLElement) {
            row.scrollIntoView({ block: "center", behavior: "auto" });
            row.classList.add("a2ui-chat-message-flash");
            window.setTimeout(
              () => row.classList.remove("a2ui-chat-message-flash"),
              1200,
            );
          }
        }, 0);
      } else {
        const row = el.querySelectorAll(".a2ui-chat-message")[idx - start];
        if (row instanceof HTMLElement) {
          row.scrollIntoView({ block: "center", behavior: "auto" });
          row.classList.add("a2ui-chat-message-flash");
          window.setTimeout(
            () => row.classList.remove("a2ui-chat-message-flash"),
            1200,
          );
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToMatch]);

  // Notify the sticky-scroll hook when new messages arrive so it can
  // auto-scroll if the user is already at the bottom.
  const prevLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== prevLength.current) {
      prevLength.current = messages.length;
      handleContentChanged();
    }
  }, [messages.length, handleContentChanged]);

  useEffect(() => {
    if (messages.length < visibleCount) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisibleCount(INITIAL_VISIBLE_MESSAGES);
    }
  }, [messages.length, visibleCount]);

  return (
    <div className="a2ui-chat-history" ref={listRef}>
      {messages.length === 0 ? (
        <div className="a2ui-chat-empty">{emptyHint}</div>
      ) : (
        <>
          {hiddenCount > 0 && (
            <button
              type="button"
              className="a2ui-chat-load-older"
              onClick={() =>
                setVisibleCount((n) =>
                  Math.min(messages.length, n + MESSAGE_PAGE_SIZE),
                )
              }
            >
              Load older messages ({hiddenCount})
            </button>
          )}
          {visibleMessages.map((m, i) => (
            <ChatMessageRow
              key={m.id}
              message={m}
              state={state}
              tabId={tabId}
              prevRole={i > 0 ? visibleMessages[i - 1].role : undefined}
              onEvent={onEvent}
              deliveryText={queuedLabels.get(m.id)}
            />
          ))}
        </>
      )}
      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MainCanvas — the slot where agent-emitted A2UI flows in. Renders a chat
// feed (history) plus a live "current canvas" subtree if state.canvas is set.
// ---------------------------------------------------------------------------

export function MainCanvas({
  component,
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    slot?: string;
    messages?: { $ref: string };
    /** Text shown when the canvas has no messages and no live subtree.
     *  Lifted out of inline JSX so brand/voice can be overridden via $ref
     *  without forking the composite. */
    emptyHint?: StringValue;
  };

  // Chat-mode is opt-in: extensions hosting non-chat content (galleries,
  // dashboards, etc.) bind only `slot` and omit `messages`. Without
  // messages bound, the canvas is a pure scroll viewport — no chat
  // empty-state, no message list, no "↓ latest" pill bleeding through.
  const chatMode = props.messages !== undefined;
  const messages = useMemo(
    () =>
      chatMode
        ? (resolvePointer(state, props.messages!.$ref) as ChatMessage[]) || []
        : [],
    [chatMode, props.messages, state],
  );
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  );
  const queuedLabels = useMemo(() => queuedDeliveryLabels(messages), [messages]);
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in live
      ? (live as { components: A2UIComponent[] })
      : null;

  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "The agent's canvas is empty. Send a message to populate it.";

  const listRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(listRef);

  const prevLength = useRef(messages.length);
  const prevLive = useRef(liveSubtree);
  useEffect(() => {
    const lengthChanged = messages.length !== prevLength.current;
    const liveChanged = liveSubtree !== prevLive.current;
    prevLength.current = messages.length;
    prevLive.current = liveSubtree;
    if (lengthChanged || liveChanged) handleContentChanged();
  }, [messages.length, liveSubtree, handleContentChanged]);

  useEffect(() => {
    if (messages.length < visibleCount) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisibleCount(INITIAL_VISIBLE_MESSAGES);
    }
  }, [messages.length, visibleCount]);

  return (
    <main
      className={chatMode ? "a2ui-canvas" : "a2ui-canvas a2ui-canvas-bare"}
      ref={listRef}
    >
      {chatMode && messages.length === 0 && !liveSubtree && (
        <div className="a2ui-canvas-empty">{emptyHint}</div>
      )}
      {chatMode && hiddenCount > 0 && (
        <button
          type="button"
          className="a2ui-chat-load-older"
          onClick={() =>
            setVisibleCount((n) =>
              Math.min(messages.length, n + MESSAGE_PAGE_SIZE),
            )
          }
        >
          Load older messages ({hiddenCount})
        </button>
      )}
      {visibleMessages.map((m, i) => (
        <ChatMessageRow
          key={m.id}
          message={m}
          state={state}
          tabId={tabId}
          className="a2ui-canvas-message"
          prevRole={i > 0 ? visibleMessages[i - 1].role : undefined}
          onEvent={onEvent}
          deliveryText={queuedLabels.get(m.id)}
        />
      ))}
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
      {chatMode &&
        state.waiting === true &&
        !liveSubtree &&
        messages.length > 0 && <TypingIndicator />}
      {chatMode && (
        <ScrollToBottomPill
          visible={!isAtBottom && (messages.length > 0 || !!liveSubtree)}
          onClick={scrollToBottom}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// ChatInput — single-line composer. Submits via onSubmit event with `{ value }`.
// ---------------------------------------------------------------------------

interface SlashCommandHint {
  name: string;
  description?: string;
  usage?: string;
  /** JSON Pointer into App state. When set, the picker fetches the array
   *  at this path the moment the user types `/<name> ` and surfaces the
   *  entries as completions. Each entry can be a `{value,label}`,
   *  `{id,label}`, or a plain string — the picker normalizes all three. */
  argSource?: string;
}

interface SlashArgChoice {
  value: string;
  label?: string;
  description?: string;
  hint?: string;
}

// Normalize the arg-source array into a uniform `{value,label,description,hint}`
// shape. Accepts the most common input forms (slash-arg objects, sidebar
// items, plain strings) so a layout JSON can point at any list it already
// owns without reshaping the data.
function normalizeArgChoices(raw: unknown): SlashArgChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashArgChoice[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      out.push({ value: r });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const value =
      typeof obj.value === "string"
        ? obj.value
        : typeof obj.id === "string"
          ? obj.id
          : "";
    if (!value) continue;
    out.push({
      value,
      label: typeof obj.label === "string" ? obj.label : undefined,
      description:
        typeof obj.description === "string" ? obj.description : undefined,
      hint: typeof obj.hint === "string" ? obj.hint : undefined,
    });
  }
  return out;
}

export function ChatInput({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  // Skill-registry lookup for the queued-messages popover so a skill
  // can override the chrome via `aethon.registerComponent`. We render
  // it inline (rather than going through RegistryComponent, which
  // would synthesize a separate A2UI subtree and require the outer
  // dispatcher's signature) — its events bubble through this
  // composite's onEvent and route via `type:chat-input` with the
  // `queue:*` prefix.
  const skillRegistry = useSkillRegistry();
  const QueuedPopover = skillRegistry.resolve("queued-messages-popover");
  const props = component.props as {
    value?: StringValue;
    placeholder?: StringValue;
    /** Controls the Send ↔ Stop button swap AND whether submits are
     *  queued (true while a prompt is in flight). The textarea itself
     *  is always editable — pi's followUp queue handles overlapping
     *  prompts so users can keep typing during long turns. */
    disabled?: BooleanValue;
    onSubmit?: string;
    onChange?: string;
    // Slash command suggestions surfaced in a dropdown when the input
    // starts with `/`. Resolved as raw value (not via resolveString) so
    // the array shape comes through intact when bound by $ref.
    commands?: SlashCommandHint[] | { $ref: string };
    /** Count of queued (followUp) messages waiting behind the current
     *  prompt. Renders as a subtle badge so the user knows their
     *  Enter-press landed even though the agent is still working on
     *  the previous one. */
    queueCount?: NumberValue;
    /** Label on the primary (idle-state) button. Default "Send". */
    sendLabel?: StringValue;
    /** Label on the abort (busy-state) button. Default "Stop". */
    stopLabel?: StringValue;
    /** Tooltip on the abort button. Default "Stop the current prompt". */
    stopTitle?: StringValue;
    /** Format string for the queue badge. Use `{n}` placeholder; default
     *  "+{n}". A custom value like "queue: {n}" lets a different brand
     *  voice show through without forking the composite. */
    queueBadgeFormat?: StringValue;
  };

  const externalValue = props.value ? resolveString(props.value, state) : "";
  const [localValue, setLocalValue] = useState(externalValue);
  const localValueRef = useRef(localValue);
  const lastExternalValueRef = useRef(externalValue);
  const draftTimerRef = useRef<number | null>(null);
  const lastCommittedDraftRef = useRef(externalValue);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  function commitDraft(next: string) {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (next === lastCommittedDraftRef.current) return;
    lastCommittedDraftRef.current = next;
    onEventRef.current("change", { value: next });
  }

  useEffect(() => {
    if (externalValue === lastExternalValueRef.current) return;
    if (
      draftTimerRef.current !== null &&
      localValueRef.current !== lastCommittedDraftRef.current
    ) {
      commitDraft(localValueRef.current);
    }
    lastExternalValueRef.current = externalValue;
    lastCommittedDraftRef.current = externalValue;
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    setLocalValue(externalValue);
  }, [externalValue]);

  const scheduleDraftCommit = () => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      commitDraft(localValueRef.current);
    }, DRAFT_COMMIT_DELAY_MS);
  };

  useEffect(() => {
    return () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      const latest = localValueRef.current;
      if (latest !== lastCommittedDraftRef.current) {
        onEventRef.current("change", { value: latest });
      }
    };
  }, []);

  const value = localValue;
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const busy = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const queueCount = props.queueCount
    ? resolveNumber(props.queueCount, state)
    : 0;
  const sendLabel = props.sendLabel
    ? resolveString(props.sendLabel, state)
    : "Send";
  const stopLabel = props.stopLabel
    ? resolveString(props.stopLabel, state)
    : "Stop";
  const stopTitle = props.stopTitle
    ? resolveString(props.stopTitle, state)
    : "Stop the current prompt";
  const queuedMessageLabel = `${queueCount} message${queueCount === 1 ? "" : "s"} queued`;
  const effectiveStopLabel =
    queueCount > 0 && !props.stopLabel ? "Stop + clear" : stopLabel;
  const effectiveStopTitle =
    queueCount > 0
      ? `Stop the current prompt and clear ${queuedMessageLabel}`
      : stopTitle;
  const queueBadgeFormat = props.queueBadgeFormat
    ? resolveString(props.queueBadgeFormat, state)
    : "+{n}";

  // Resolve the commands list. Supports inline arrays or $ref-bound state.
  const commandsRaw = props.commands;
  const commands: SlashCommandHint[] = useMemo(() => {
    if (!commandsRaw) return [];
    if (Array.isArray(commandsRaw)) return commandsRaw;
    if (typeof commandsRaw === "object" && "$ref" in commandsRaw) {
      const resolved = resolvePointer(state, commandsRaw.$ref);
      return Array.isArray(resolved) ? (resolved as SlashCommandHint[]) : [];
    }
    return [];
  }, [commandsRaw, state]);

  // Tracks the draft value the user pressed Escape on. While the live value
  // matches that snapshot, the picker stays dismissed so Escape doesn't
  // require clearing the input. Editing the draft (any change) re-opens
  // — implemented by clearing the snapshot in an effect when value moves
  // away from it. We can't derive this during render: the snapshot must
  // *not* re-suppress the picker when the user backspaces back to the
  // same value, so we need a one-shot reset that fires on every value
  // change. The React 19 lint rule flags setState-in-effect, but here
  // it's the cleanest expression of the semantic.
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  useEffect(() => {
    if (dismissedDraft !== null && value !== dismissedDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissedDraft(null);
    }
  }, [value, dismissedDraft]);

  // Slash autocomplete operates in two modes:
  //   1. command-mode  — `/foo` (no space yet)        → suggest matching commands
  //   2. arg-mode      — `/<cmd> <prefix>` (one space) → suggest values from the
  //                                                       command's argSource state path
  // Both use the same picker UI; each match shape is normalized to a
  // common interface so the renderer below doesn't branch.
  type CommandMatch = { kind: "command"; cmd: SlashCommandHint };
  type ArgMatch = {
    kind: "arg";
    cmd: SlashCommandHint;
    choice: SlashArgChoice;
  };
  type PickerMatch = CommandMatch | ArgMatch;

  const slashMatch = useMemo((): {
    mode: "command" | "arg";
    prefix: string;
    matches: PickerMatch[];
    cmd?: SlashCommandHint;
  } | null => {
    if (dismissedDraft !== null && value === dismissedDraft) return null;
    // Command mode: just the slash + an optional partial name, no space.
    const cmdM = value.match(/^\/([A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?)?$/);
    if (cmdM) {
      const prefix = (cmdM[1] ?? "").toLowerCase();
      const matches: PickerMatch[] = commands
        .filter((c) => c.name.toLowerCase().startsWith(prefix))
        .map((cmd) => ({ kind: "command", cmd }));
      return matches.length > 0 ? { mode: "command", prefix, matches } : null;
    }
    // Arg mode: `/<cmd> <prefix>` — exactly one space between the
    // command name and the (optionally empty) argument prefix. We
    // intentionally don't support multi-arg commands yet; the spec for
    // those should land alongside the first command that needs it.
    const argM = value.match(
      /^\/([A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?) ([^\n]*)$/,
    );
    if (argM) {
      const cmdName = argM[1].toLowerCase();
      const argPrefix = argM[2].toLowerCase();
      const cmd = commands.find((c) => c.name.toLowerCase() === cmdName);
      if (!cmd || !cmd.argSource) return null;
      const raw = resolvePointer(state, cmd.argSource);
      const choices = normalizeArgChoices(raw).filter((ch) => {
        const haystack = `${ch.value} ${ch.label ?? ""}`.toLowerCase();
        return haystack.includes(argPrefix);
      });
      const matches: PickerMatch[] = choices.map((choice) => ({
        kind: "arg",
        cmd,
        choice,
      }));
      return matches.length > 0
        ? { mode: "arg", prefix: argPrefix, matches, cmd }
        : null;
    }
    return null;
  }, [value, commands, state, dismissedDraft]);

  const [highlightIdx, setHighlightIdx] = useState(0);
  // Reset highlight when the visible list changes so the cursor stays inside
  // bounds and on the first suggestion for a new prefix.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightIdx(0);
  }, [slashMatch?.matches.length, slashMatch?.prefix, slashMatch?.mode]);

  // The slash menu is portalled to document.body so it can't be clipped by
  // ancestor `overflow: hidden` (the default-layout grid cell uses that to
  // contain chat history scrolling). Track the chat-input rect so we can
  // anchor the menu in fixed coordinates above it.
  const inputContainerRef = useRef<HTMLDivElement>(null);

  // User-resizable composer. Drag the top edge to grow / shrink the
  // textarea — height is clamped to keep the chat above usable. Reset
  // happens via the boot default; we don't persist across sessions yet
  // since the layout's auto-rows already hold a sensible default.
  const COMPOSER_MIN_HEIGHT = 46;
  const COMPOSER_MAX_HEIGHT = 360;
  const [composerHeight, setComposerHeight] = useState<number>(70);
  const composerResizeRef = useRef<{ startY: number; startH: number } | null>(
    null,
  );

  const startComposerResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      composerResizeRef.current = {
        startY: e.clientY,
        startH: composerHeight,
      };
      document.body.classList.add("ae-resizing-composer");
      const onMove = (ev: MouseEvent) => {
        const ref = composerResizeRef.current;
        if (!ref) return;
        // Drag UP = grow (dy positive).
        const dy = ref.startY - ev.clientY;
        const next = Math.max(
          COMPOSER_MIN_HEIGHT,
          Math.min(COMPOSER_MAX_HEIGHT, Math.round(ref.startH + dy)),
        );
        setComposerHeight(next);
      };
      const onUp = () => {
        composerResizeRef.current = null;
        document.body.classList.remove("ae-resizing-composer");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [composerHeight],
  );
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!slashMatch || !inputContainerRef.current) {
      setMenuAnchor(null);
      return;
    }
    const update = () => {
      const r = inputContainerRef.current!.getBoundingClientRect();
      const scale = readUiScale();
      const viewportWidth = window.innerWidth / scale;
      const viewportHeight = window.innerHeight / scale;
      const left = Math.max(
        8,
        Math.min(r.left / scale + 16, viewportWidth - 128),
      );
      const availableWidth = Math.max(0, viewportWidth - left - 8);
      const preferredWidth = Math.max(160, r.width / scale - 32);
      setMenuAnchor({
        left,
        bottom: Math.max(8, viewportHeight - r.top / scale + 4),
        width: Math.min(preferredWidth, availableWidth || preferredWidth),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [slashMatch]);

  // Insert the highlighted picker entry — for command-mode that completes
  // to `/<name> ` (cursor primed for an arg); for arg-mode it completes
  // to `/<name> <value>` ready to submit.
  const insertMatch = (m: PickerMatch) => {
    const text =
      m.kind === "command"
        ? `/${m.cmd.name} `
        : `/${m.cmd.name} ${m.choice.value}`;
    setLocalValue(text);
    commitDraft(text);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setLocalValue(next);
    scheduleDraftCommit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const submit = (mode: "normal" | "steer") => {
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length === 0) return;
      commitDraft(v);
      onEvent("submit", { value: v, mode });
    };

    if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit("steer");
      return;
    }

    if (slashMatch) {
      const list = slashMatch.matches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertMatch(list[highlightIdx] ?? list[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Just dismiss the picker — keep the typed text intact. The
        // dismissedDraft snapshot above re-opens the picker as soon as
        // the user edits the draft again.
        setDismissedDraft(value);
        return;
      }
      // Enter behavior with the picker open:
      //   - command-mode: complete to `/<name> ` (or submit if the draft
      //     already matches a command exactly so the user doesn't have
      //     to press Enter twice).
      //   - arg-mode: insert + submit on the same Enter — the user has
      //     already named the command and chosen a value, so there's
      //     nothing left to do.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = (e.target as HTMLTextAreaElement).value;
        if (slashMatch.mode === "arg") {
          const choice = (list[highlightIdx] ?? list[0]) as ArgMatch;
          const submitText = `/${choice.cmd.name} ${choice.choice.value}`;
          setLocalValue(submitText);
          commitDraft(submitText);
          onEvent("submit", { value: submitText, mode: "normal" });
          return;
        }
        const exact = (list as CommandMatch[]).find(
          (c) => v === `/${c.cmd.name}` || v.startsWith(`/${c.cmd.name} `),
        );
        if (exact && v.trim().length > 0) {
          onEvent("submit", { value: v, mode: "normal" });
          return;
        }
        insertMatch(list[highlightIdx] ?? list[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Always submit — the bridge uses pi's followUp queue when an
      // earlier prompt is still in flight, so the user can keep typing
      // without "agent busy" rejections. Cmd/Ctrl+Enter above opts into
      // mid-turn steering instead.
      submit("normal");
    }
  };

  const handleClick = () => {
    if (value.trim().length > 0) {
      commitDraft(value);
      onEvent("submit", { value, mode: "normal" });
    }
  };

  const handleStop = () => {
    onEvent("cancel");
  };

  return (
    <div
      className="a2ui-chat-input"
      ref={inputContainerRef}
      style={
        { "--composer-height": `${composerHeight}px` } as React.CSSProperties
      }
    >
      {/* Resize handle — drag UP to grow, DOWN to shrink. Sits on the
          top edge so the cursor naturally targets it when the user
          wants more room without changing where the textarea lives. */}
      <div
        className="a2ui-chat-input-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        title="Drag to resize composer"
        onMouseDown={startComposerResize}
      />
      {/* Queued messages popover. Rendered via the skill registry so a
          skill can swap the chrome by calling
          `aethon.registerComponent("queued-messages-popover", custom)`.
          The composite hides itself when the queue is empty.
          `createElement` (rather than `<QueuedPopover .../>` JSX) keeps
          the react-hooks/component-during-render rule happy — the
          runtime-resolved component is not a JSX-declared identifier. */}
      {QueuedPopover
        ? createElement(QueuedPopover, {
            component: {
              id: "queued-messages-popover",
              type: "queued-messages-popover",
            },
            state,
            onEvent,
          })
        : null}
      {slashMatch &&
        menuAnchor &&
        createPortal(
          <div
            className="a2ui-slash-menu"
            role="listbox"
            style={{
              position: "fixed",
              left: `${menuAnchor.left}px`,
              bottom: `${menuAnchor.bottom}px`,
              width: `${menuAnchor.width}px`,
            }}
          >
            {slashMatch.mode === "arg" && slashMatch.cmd && (
              <div className="a2ui-slash-arg-header">
                <span className="a2ui-slash-arg-cmd">
                  /{slashMatch.cmd.name}
                </span>
                <span className="a2ui-slash-arg-hint">
                  {slashMatch.cmd.description ?? "select an option"}
                </span>
              </div>
            )}
            {slashMatch.matches.map((m, i) => {
              const key =
                m.kind === "command"
                  ? m.cmd.name
                  : `${m.cmd.name}::${m.choice.value}`;
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={i === highlightIdx}
                  className={
                    i === highlightIdx
                      ? "a2ui-slash-item a2ui-slash-item-active"
                      : "a2ui-slash-item"
                  }
                  onMouseDown={(e) => {
                    // mousedown (not click) so the textarea doesn't lose focus
                    // before the insertion fires.
                    e.preventDefault();
                    if (m.kind === "arg") {
                      const submitText = `/${m.cmd.name} ${m.choice.value}`;
                      setLocalValue(submitText);
                      commitDraft(submitText);
                      onEvent("submit", { value: submitText, mode: "normal" });
                    } else {
                      insertMatch(m);
                    }
                  }}
                  onMouseEnter={() => setHighlightIdx(i)}
                >
                  {m.kind === "command" ? (
                    <>
                      <span className="a2ui-slash-item-name">
                        /{m.cmd.name}
                      </span>
                      {m.cmd.usage && (
                        <span className="a2ui-slash-item-usage">
                          {" "}
                          {m.cmd.usage}
                        </span>
                      )}
                      {m.cmd.description && (
                        <span className="a2ui-slash-item-desc">
                          {" "}
                          — {m.cmd.description}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="a2ui-slash-item-name">
                        {m.choice.value}
                      </span>
                      {m.choice.label && m.choice.label !== m.choice.value && (
                        <span className="a2ui-slash-item-desc">
                          {" "}
                          — {m.choice.label}
                        </span>
                      )}
                      {m.choice.description && (
                        <span className="a2ui-slash-item-desc">
                          {" "}
                          — {m.choice.description}
                        </span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      {busy && (
        <div className="a2ui-chat-input-hint">
          <span>Enter queues</span>
          <span>Cmd/Ctrl+Enter steers</span>
        </div>
      )}
      {/* Wrap the textarea and action button so Send sits INSIDE the
          textarea visually (absolute-positioned, bottom-right). Right
          padding on the textarea makes room for the button so text
          never runs under it. */}
      <div className="a2ui-chat-input-field-wrap">
        <textarea
          className="a2ui-chat-input-field"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {/* Queue badge — visible when the user has stacked messages
            behind an in-flight prompt. Sits inside the wrap to the
            left of the Send/Stop button. */}
        {queueCount > 0 && (
          <span
            className="a2ui-chat-input-queue"
            title={`${queuedMessageLabel} behind the current prompt`}
          >
            {queueBadgeFormat.replace("{n}", String(queueCount))}
          </span>
        )}
        {busy ? (
          <button
            type="button"
            className="a2ui-chat-input-send a2ui-chat-input-stop"
            onClick={handleStop}
            title={effectiveStopTitle}
            aria-label={effectiveStopLabel}
          >
            <svg
              className="a2ui-chat-input-send-icon"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <rect
                x="3"
                y="3"
                width="10"
                height="10"
                rx="1.5"
                fill="currentColor"
              />
            </svg>
            <span className="a2ui-chat-input-send-label">
              {effectiveStopLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="a2ui-chat-input-send"
            onClick={handleClick}
            disabled={value.trim().length === 0}
            aria-label={sendLabel}
            title={`${sendLabel} (Enter)`}
          >
            <svg
              className="a2ui-chat-input-send-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 8l11-5-4 11-2-5-5-1z" />
            </svg>
            <span className="a2ui-chat-input-send-label">{sendLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueuedMessagesPopover — Claudette-style popover above the composer. Lets
// the user inspect, edit, delete, or promote-to-steer each message they
// queued while the agent was busy. Drained automatically by
// `useQueuedDispatch` on the next idle (head only); the popover only
// disappears when the queue is empty (zero items renders nothing so the
// composer stays flush).
//
// State contract:
//   /queuedMessages: QueuedMessage[]            — mirrored from active tab
//   /queuedSteeringId?: string                  — id mid-steer (spinner)
//
// Events emitted:
//   edit   { messageId, content }
//   delete { messageId }
//   steer  { messageId }
//   clear
// ---------------------------------------------------------------------------

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5l5 5 5-5" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  );
}

function SteerIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 8l11-5-4 11-2-5-5-1z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9" />
    </svg>
  );
}

function QueuedSpinner() {
  return (
    <svg
      className="a2ui-queued-spinner"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface QueuedMessageRowProps {
  message: QueuedMessage;
  steering: boolean;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onSteer: (id: string) => void;
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  message,
  steering,
  onEdit,
  onDelete,
  onSteer,
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      // Sync the draft from the latest content whenever editing opens —
      // covers the case where the row's content changed externally
      // (auto-dispatch popped a different row, or a remote edit) while
      // the user was deciding to click Edit. setState-in-effect here is
      // intentional: we resync the local textarea to authoritative
      // content the moment the user enters edit mode.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(message.content);
      // Focus + select-all so the user can overwrite without clearing
      // manually. requestAnimationFrame waits one frame so the textarea
      // is in the DOM before .focus() runs.
      const handle = requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.select();
      });
      return () => cancelAnimationFrame(handle);
    }
    return undefined;
  }, [editing, message.content]);

  function commitEdit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      // An empty edit is a delete — Claudette behavior. Don't keep a
      // blank row in the queue.
      onDelete(message.id);
    } else if (trimmed !== message.content) {
      onEdit(message.id, trimmed);
    }
    setEditing(false);
  }

  function cancelEdit() {
    setDraft(message.content);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
  }

  if (editing) {
    return (
      <li className="a2ui-queued-message a2ui-queued-message-editing">
        <div className="a2ui-queued-edit-form">
          <textarea
            ref={textareaRef}
            className="a2ui-queued-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            aria-label="Edit queued message"
          />
          <div className="a2ui-queued-edit-buttons">
            <button
              type="button"
              className="a2ui-queued-action a2ui-queued-edit-save"
              onClick={commitEdit}
              title="Save (Enter)"
              aria-label="Save edit"
            >
              Save
            </button>
            <button
              type="button"
              className="a2ui-queued-action a2ui-queued-edit-cancel"
              onClick={cancelEdit}
              title="Cancel (Esc)"
              aria-label="Cancel edit"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="a2ui-queued-message">
      <span className="a2ui-queued-icon" aria-hidden="true">
        <ChevronIcon />
      </span>
      <span className="a2ui-queued-content" title={message.content}>
        {message.content}
      </span>
      <div className="a2ui-queued-actions">
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-edit"
          onClick={() => setEditing(true)}
          title="Edit"
          aria-label="Edit queued message"
          disabled={steering}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-steer"
          onClick={() => onSteer(message.id)}
          title="Send now as steer"
          aria-label="Steer this message into the current turn"
          disabled={steering}
        >
          {steering ? <QueuedSpinner /> : <SteerIcon />}
          <span className="a2ui-queued-steer-label">
            {steering ? "STEER…" : "STEER"}
          </span>
        </button>
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-delete"
          onClick={() => onDelete(message.id)}
          title="Remove from queue"
          aria-label="Remove from queue"
          disabled={steering}
        >
          <DeleteIcon />
        </button>
      </div>
    </li>
  );
});

export function QueuedMessagesPopover({
  state,
  onEvent,
}: BuiltinComponentProps) {
  // Read straight from root state — useTabs mirrors the active tab's
  // queuedMessages + queuedSteeringId on switch and per update.
  const items = (state.queuedMessages as QueuedMessage[] | undefined) ?? [];
  const steeringId = state.queuedSteeringId as string | undefined;
  if (items.length === 0) return null;

  // Prefix the wire event names so they're unambiguous when they
  // bubble up through the host composite's onEvent (events route by
  // type:<host-type>, not by the popover's identity, when this
  // composite is rendered inline inside another composite — the
  // common case when a skill hosts the popover inside its own
  // ChatInput replacement). The `queue:` prefix lets `queue.ts`
  // route handler match without colliding with the host's own
  // events.
  const onEdit = (id: string, content: string) => {
    onEvent("queue:edit", { messageId: id, content });
  };
  const onDelete = (id: string) => {
    onEvent("queue:delete", { messageId: id });
  };
  const onSteer = (id: string) => {
    onEvent("queue:steer", { messageId: id });
  };
  const onClear = () => {
    onEvent("queue:clear");
  };

  return (
    <div
      className="a2ui-queued-popover"
      role="region"
      aria-label="Queued messages"
    >
      <div className="a2ui-queued-header">
        <span className="a2ui-queued-label">
          Queued · {items.length}
        </span>
        <button
          type="button"
          className="a2ui-queued-clear"
          onClick={onClear}
          aria-label="Clear queue"
          title="Drop every queued message"
        >
          Clear queue
        </button>
      </div>
      <ul className="a2ui-queued-list">
        {items.map((m) => (
          <QueuedMessageRow
            key={m.id}
            message={m}
            steering={steeringId === m.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onSteer={onSteer}
          />
        ))}
      </ul>
    </div>
  );
}
