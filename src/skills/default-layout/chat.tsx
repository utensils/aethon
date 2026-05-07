/**
 * Chat composites for the default-layout skill — `ChatHistory`,
 * `ChatInput` (with the slash-command palette), `ToolCard` (live
 * elapsed-time clock for agent tool calls), and the `MainCanvas` host
 * that pairs message history with a live-rendered A2UI subtree.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  };
  const baseTitle = props.title ? resolveString(props.title, state) : "";
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const startedAt = props.startedAt
    ? resolveNumber(props.startedAt, state)
    : undefined;
  const endedAt = props.endedAt ? resolveNumber(props.endedAt, state) : undefined;
  const isError = props.isError
    ? resolveBoolean(props.isError, state)
    : false;
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

  const titleSuffix = useMemo(() => {
    if (running) return ` · running… ${formatToolDuration(elapsedMs)}`;
    if (isError) return ` · failed in ${formatToolDuration(elapsedMs)}`;
    if (startedAt !== undefined)
      return ` · completed in ${formatToolDuration(elapsedMs)}`;
    return "";
  }, [running, isError, startedAt, elapsedMs]);

  const accentColor = isError
    ? "var(--danger, #c5494a)"
    : isLongRunning
      ? "var(--warning, #d18a2c)"
      : running
        ? "var(--accent)"
        : "var(--text-dim)";

  return (
    <details
      className="ae-tool-card"
      data-running={running ? "true" : "false"}
      data-long-running={isLongRunning ? "true" : "false"}
      data-error={isError ? "true" : "false"}
    >
      <summary className="ae-tool-card-summary">
        <span className="ae-tool-card-title" style={{ color: accentColor }}>
          <span className="ae-tool-card-title-base">{baseTitle}</span>
          <span className="ae-tool-card-title-suffix">{titleSuffix}</span>
        </span>
        {description && (
          <span className="ae-tool-card-description">{description}</span>
        )}
      </summary>
      <div className="ae-tool-card-body">
        {isLongRunning && (
          <div className="ae-tool-card-warning">
            Long-running command — press <kbd>⌘.</kbd> to stop.
          </div>
        )}
        {hasChildren ? renderChildren?.() : (
          <div className="ae-tool-card-empty">No output</div>
        )}
      </div>
    </details>
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
        <ReactMarkdown components={MARKDOWN_COMPONENTS}>{children}</ReactMarkdown>
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
  }: {
    message: ChatMessage;
    state: Record<string, unknown>;
    tabId?: string;
    className?: string;
  }) {
    return (
      <div className={`${className} ${message.role}`}>
        <span className={className === "a2ui-canvas-message" ? "a2ui-canvas-role" : "a2ui-chat-role"}>
          {roleBadge(message.role)}
        </span>
        {message.thinking && (
          <ThinkingBlock complete={Boolean(message.text)}>
            {message.thinking}
          </ThinkingBlock>
        )}
        {message.text && (
          <div
            className={
              className === "a2ui-canvas-message"
                ? "a2ui-canvas-text a2ui-markdown"
                : "a2ui-chat-text a2ui-markdown"
            }
          >
            {className === "a2ui-canvas-message" ? (
              <ReactMarkdown>{message.text}</ReactMarkdown>
            ) : (
              <MemoMarkdownWithThinking text={message.text} />
            )}
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
    (!next.message.a2ui || prev.state === next.state),
);

export function ChatHistory({ component, state, tabId }: BuiltinComponentProps) {
  const props = component.props as {
    messages: { $ref: string };
    emptyHint?: StringValue;
  };

  const listRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, handleContentChanged } = useStickyScroll(listRef);

  const messages = useMemo(
    () => (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [],
    [props.messages.$ref, state],
  );
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  );
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
    if (!el || !scrollToMatch || scrollToMatch === prevScrollToMatch.current) return;
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
          {visibleMessages.map((m) => (
            <ChatMessageRow key={m.id} message={m} state={state} tabId={tabId} />
          ))}
        </>
      )}
      <ScrollToBottomPill visible={!isAtBottom && messages.length > 0} onClick={scrollToBottom} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MainCanvas — the slot where agent-emitted A2UI flows in. Renders a chat
// feed (history) plus a live "current canvas" subtree if state.canvas is set.
// ---------------------------------------------------------------------------

export function MainCanvas({ component, state, tabId }: BuiltinComponentProps) {
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
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in (live)
      ? (live as { components: A2UIComponent[] })
      : null;

  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "The agent's canvas is empty. Send a message to populate it.";

  const listRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, handleContentChanged } = useStickyScroll(listRef);

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
      className={
        chatMode ? "a2ui-canvas" : "a2ui-canvas a2ui-canvas-bare"
      }
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
            setVisibleCount((n) => Math.min(messages.length, n + MESSAGE_PAGE_SIZE))
          }
        >
          Load older messages ({hiddenCount})
        </button>
      )}
      {visibleMessages.map((m) => (
        <ChatMessageRow
          key={m.id}
          message={m}
          state={state}
          tabId={tabId}
          className="a2ui-canvas-message"
        />
      ))}
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
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

export function ChatInput({ component, state, onEvent }: BuiltinComponentProps) {
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

  useEffect(() => {
    if (externalValue === lastExternalValueRef.current) return;
    lastExternalValueRef.current = externalValue;
    lastCommittedDraftRef.current = externalValue;
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    setLocalValue(externalValue);
  }, [externalValue]);

  const commitDraft = (next: string) => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (next === lastCommittedDraftRef.current) return;
    lastCommittedDraftRef.current = next;
    onEventRef.current("change", { value: next });
  };

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
  const queueCount = props.queueCount ? resolveNumber(props.queueCount, state) : 0;
  const sendLabel = props.sendLabel ? resolveString(props.sendLabel, state) : "Send";
  const stopLabel = props.stopLabel ? resolveString(props.stopLabel, state) : "Stop";
  const stopTitle = props.stopTitle
    ? resolveString(props.stopTitle, state)
    : "Stop the current prompt";
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
  type ArgMatch = { kind: "arg"; cmd: SlashCommandHint; choice: SlashArgChoice };
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
      const left = Math.max(8, Math.min(r.left / scale + 16, viewportWidth - 128));
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
      m.kind === "command" ? `/${m.cmd.name} ` : `/${m.cmd.name} ${m.choice.value}`;
    setLocalValue(text);
    commitDraft(text);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setLocalValue(next);
    scheduleDraftCommit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
          onEvent("submit", { value: submitText });
          return;
        }
        const exact = (list as CommandMatch[]).find(
          (c) => v === `/${c.cmd.name}` || v.startsWith(`/${c.cmd.name} `),
        );
        if (exact && v.trim().length > 0) {
          onEvent("submit", { value: v });
          return;
        }
        insertMatch(list[highlightIdx] ?? list[0]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length > 0) {
        // Always submit — the bridge uses pi's followUp queue when an
        // earlier prompt is still in flight, so the user can keep
        // typing without "agent busy" rejections.
        commitDraft(v);
        onEvent("submit", { value: v });
      }
    }
  };

  const handleClick = () => {
    if (value.trim().length > 0) {
      commitDraft(value);
      onEvent("submit", { value });
    }
  };

  const handleStop = () => {
    onEvent("cancel");
  };

  return (
    <div className="a2ui-chat-input" ref={inputContainerRef}>
      {slashMatch && menuAnchor &&
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
                <span className="a2ui-slash-arg-cmd">/{slashMatch.cmd.name}</span>
                <span className="a2ui-slash-arg-hint">
                  {slashMatch.cmd.description ?? "select an option"}
                </span>
              </div>
            )}
            {slashMatch.matches.map((m, i) => {
              const key =
                m.kind === "command" ? m.cmd.name : `${m.cmd.name}::${m.choice.value}`;
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
                      onEvent("submit", { value: submitText });
                    } else {
                      insertMatch(m);
                    }
                  }}
                  onMouseEnter={() => setHighlightIdx(i)}
                >
                  {m.kind === "command" ? (
                    <>
                      <span className="a2ui-slash-item-name">/{m.cmd.name}</span>
                      {m.cmd.usage && (
                        <span className="a2ui-slash-item-usage"> {m.cmd.usage}</span>
                      )}
                      {m.cmd.description && (
                        <span className="a2ui-slash-item-desc"> — {m.cmd.description}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="a2ui-slash-item-name">{m.choice.value}</span>
                      {m.choice.label && m.choice.label !== m.choice.value && (
                        <span className="a2ui-slash-item-desc"> — {m.choice.label}</span>
                      )}
                      {m.choice.description && (
                        <span className="a2ui-slash-item-desc"> — {m.choice.description}</span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      <textarea
        className="a2ui-chat-input-field"
        rows={2}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {/* Queue badge — visible when the user has stacked messages behind
          an in-flight prompt. Sits between the textarea and the action
          button so it's near the input but doesn't compete with Stop. */}
      {queueCount > 0 && (
        <span
          className="a2ui-chat-input-queue"
          title={`${queueCount} message${queueCount === 1 ? "" : "s"} queued behind the current prompt`}
        >
          {queueBadgeFormat.replace("{n}", String(queueCount))}
        </span>
      )}
      {busy ? (
        <button
          type="button"
          className="a2ui-chat-input-send a2ui-chat-input-stop"
          onClick={handleStop}
          title={stopTitle}
        >
          {stopLabel}
        </button>
      ) : (
        <button
          type="button"
          className="a2ui-chat-input-send"
          onClick={handleClick}
          disabled={value.trim().length === 0}
        >
          <svg
            className="a2ui-chat-input-send-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2 8l11-5-4 11-2-5-5-1z" />
          </svg>
          <span>{sendLabel}</span>
        </button>
      )}
    </div>
  );
}
