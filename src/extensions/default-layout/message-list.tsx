import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type {
  A2UIComponent,
  ChatAttachment,
  ChatMessage,
  StringValue,
} from "../../types/a2ui";
import A2UIRenderer from "../../components/A2UIRenderer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";
import {
  resolveVisibility,
  type ResolvedVisibility,
} from "../../utils/visibilityResolver";
import {
  groupMessages,
  groupKey,
  isToolCardMessage,
  type MessageGroup,
} from "../../utils/toolCardGrouping";
import type { VisibilityMode } from "../../config";
import {
  CHAT_MARKDOWN_PROPS,
  CHAT_STREAMING_MARKDOWN_PROPS,
} from "./markdown-adapter";
import { isAtBottom as metricsAreAtBottom } from "../../utils/stickyScrollController";
import { ImageAttachmentImage } from "./image-attachment-image";
import { ImageLightbox } from "./image-lightbox";

// Distance (px) from the bottom still treated as "at the bottom" for follow +
// the scroll-to-bottom pill. Matches the old StickyScrollController default.
const DEFAULT_AT_BOTTOM_THRESHOLD = 60;
const PROGRAMMATIC_SCROLL_GUARD_MS = 1200;
const FENCED_CODE_MARKER_RE = /(^|\n)(```|~~~)/;
const USER_SCROLL_INTENT_EVENTS = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;

function addUserScrollIntentListeners(
  el: HTMLElement,
  listener: EventListener,
): void {
  for (const eventName of USER_SCROLL_INTENT_EVENTS) {
    el.addEventListener(eventName, listener, { passive: true });
  }
}

function removeUserScrollIntentListeners(
  el: HTMLElement,
  listener: EventListener,
): void {
  for (const eventName of USER_SCROLL_INTENT_EVENTS) {
    el.removeEventListener(eventName, listener);
  }
}

// Top-level state keys that change identity on every streamed token — the
// active tab's `messages` array and the `tabs` array that nests it (both
// rewritten by `updateTab` / TAB_MIRROR_KEYS on each delta). Historical chat
// rows never read these, so the row memo can ignore them: an already-rendered
// A2UI row stays put across a streaming turn instead of reconciling the whole
// list on every token (#159 chat-lag fix).
const VOLATILE_ROW_STATE_KEYS: ReadonlySet<string> = new Set([
  "messages",
  "tabs",
]);

/** Shallow equality of two state records, ignoring `exclude`d keys. Lets the
 *  chat-row memo bail when only the per-token-volatile `messages`/`tabs` keys
 *  changed. Cheap (a ~15-key reference scan) and only reached after the
 *  cheaper message/onEvent identity checks already passed. */
function shallowEqualExcept(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  exclude: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a)) {
    if (exclude.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  // Catch retained keys that exist only in `b` (added since the last render).
  for (const key of Object.keys(b)) {
    if (exclude.has(key)) continue;
    if (!(key in a)) return false;
  }
  return true;
}

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
  collapsed = false,
}: {
  children: string;
  complete?: boolean;
  /** When true (visibility = "collapse") the block never auto-expands, even
   *  while streaming — it stays a quiet "Thinking" label the user can open. */
  collapsed?: boolean;
}) {
  const label = complete ? "Thinking" : "Thinking...";
  return (
    <details
      className="a2ui-thinking-block"
      open={collapsed ? false : !complete}
    >
      <summary>{label}</summary>
      <div className="a2ui-thinking-content a2ui-markdown">
        <ReactMarkdown {...CHAT_MARKDOWN_PROPS}>{children}</ReactMarkdown>
      </div>
    </details>
  );
}

function hasFencedCodeMarker(text: string | undefined): boolean {
  return FENCED_CODE_MARKER_RE.test(text ?? "");
}

function MarkdownWithThinking({
  text,
  streamingFences = false,
  thinkingVisibility = "show",
}: {
  text: string;
  streamingFences?: boolean;
  thinkingVisibility?: VisibilityMode;
}) {
  const markdownProps = streamingFences
    ? CHAT_STREAMING_MARKDOWN_PROPS
    : CHAT_MARKDOWN_PROPS;
  return (
    <>
      {splitThinkingBlocks(text).map((segment, index) => {
        if (!segment.content) return null;
        if (segment.type === "thinking") {
          if (thinkingVisibility === "hide") return null;
          return (
            <ThinkingBlock
              key={index}
              complete={segment.closed !== false}
              collapsed={thinkingVisibility === "collapse"}
            >
              {segment.content}
            </ThinkingBlock>
          );
        }
        return (
          <ReactMarkdown key={index} {...markdownProps}>
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </>
  );
}

const MemoMarkdownWithThinking = memo(MarkdownWithThinking);

function AttachmentGallery({ attachments }: { attachments: ChatAttachment[] }) {
  const [open, setOpen] = useState<ChatAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="a2ui-message-attachments">
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            className="a2ui-message-attachment"
            onClick={() => setOpen(attachment)}
            aria-label={`Open ${attachment.name}`}
          >
            <ImageAttachmentImage attachment={attachment} alt="" />
            <span>{attachment.name}</span>
          </button>
        ))}
      </div>
      {open && (
        <ImageLightbox attachment={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

export const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    state,
    tabId,
    className = "a2ui-chat-message",
    prevRole,
    onEvent,
    deliveryText,
    isLatest,
    thinkingVisibility = "show",
  }: {
    message: ChatMessage;
    state: Record<string, unknown>;
    tabId?: string;
    className?: string;
    prevRole?: string;
    onEvent?: BuiltinComponentProps["onEvent"];
    deliveryText?: string;
    isLatest?: boolean;
    thinkingVisibility?: VisibilityMode;
  }) {
    const [confirmingRollback, setConfirmingRollback] = useState(false);
    // Rollback / fork are offered on real user/assistant turns that carry a pi
    // entry id (tool-card and system rows are not branch targets). Thinking-only
    // turns count too — they're valid branch points.
    const canBranch =
      Boolean(message.entryId) &&
      (message.role === "user" || message.role === "agent") &&
      (Boolean(message.text) || Boolean(message.thinking)) &&
      Boolean(onEvent);
    const isCanvas = className === "a2ui-canvas-message";
    const roleClass = isCanvas ? "a2ui-canvas-role" : "a2ui-chat-role";
    const textClass = isCanvas
      ? "a2ui-canvas-text a2ui-markdown"
      : "a2ui-chat-text a2ui-markdown";
    const showRole = prevRole !== message.role;
    const delivery =
      message.role === "user"
        ? (deliveryText ?? deliveryLabel(message.delivery))
        : null;
    const streamingFences =
      isLatest &&
      message.role === "agent" &&
      state.waiting === true &&
      hasFencedCodeMarker(message.text);
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
        {message.thinking && thinkingVisibility !== "hide" && (
          <ThinkingBlock
            complete={Boolean(message.text)}
            collapsed={thinkingVisibility === "collapse"}
          >
            {message.thinking}
          </ThinkingBlock>
        )}
        {message.text && (
          <div className={textClass}>
            <MemoMarkdownWithThinking
              text={message.text}
              streamingFences={streamingFences}
              thinkingVisibility={thinkingVisibility}
            />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentGallery attachments={message.attachments} />
        )}
        {message.a2ui && (
          <A2UIRenderer payload={message.a2ui} state={state} tabId={tabId} />
        )}
        {canBranch && (
          <div
            className="ae-msg-branch-actions"
            onMouseLeave={() => setConfirmingRollback(false)}
          >
            {confirmingRollback ? (
              <>
                <button
                  type="button"
                  className="ae-msg-branch-btn ae-msg-branch-confirm"
                  onClick={() => {
                    setConfirmingRollback(false);
                    onEvent?.("rollback-to-here", { entryId: message.entryId });
                  }}
                >
                  Confirm rollback
                </button>
                <button
                  type="button"
                  className="ae-msg-branch-btn"
                  onClick={() => setConfirmingRollback(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ae-msg-branch-btn"
                  title="Rewind the conversation to this message"
                  onClick={() => setConfirmingRollback(true)}
                >
                  ↶ Rollback
                </button>
                <button
                  type="button"
                  className="ae-msg-branch-btn"
                  title="Fork the conversation into a new tab from here"
                  onClick={() =>
                    onEvent?.("fork-to-tab", { entryId: message.entryId })
                  }
                >
                  ⑂ Fork
                </button>
              </>
            )}
          </div>
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
    prev.thinkingVisibility === next.thinkingVisibility &&
    (!next.message.text ||
      !next.isLatest ||
      prev.state.waiting === next.state.waiting) &&
    (!next.message.text || prev.isLatest === next.isLatest) &&
    (!next.message.a2ui ||
      shallowEqualExcept(prev.state, next.state, VOLATILE_ROW_STATE_KEYS)),
);

// Footer riding below the last message inside Virtuoso's scroller, so the live
// canvas subtree + typing indicator scroll and follow with the messages. Passed
// dynamic data via Virtuoso's `context` so its component identity stays stable.
interface CanvasFooterContext {
  liveSubtree: { components: A2UIComponent[] } | null;
  showTyping: boolean;
  state: Record<string, unknown>;
  tabId?: string;
}

function CanvasFooter({ context }: { context?: CanvasFooterContext }) {
  if (!context) return null;
  const { liveSubtree, showTyping, state, tabId } = context;
  if (!liveSubtree && !showTyping) return null;
  return (
    <>
      {liveSubtree && (
        <div className="a2ui-canvas-live">
          <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
        </div>
      )}
      {showTyping && <TypingIndicator />}
    </>
  );
}

/** Title shown on a tool-call card (e.g. "bash", "read"), used for the
 *  collapsed-group peek. */
function toolCardTitle(m: ChatMessage): string | undefined {
  const comp = m.a2ui?.components?.find((c) => c?.type === "tool-card");
  const title = comp?.props?.title;
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

/** A short "name · name · …" peek of the tools inside a collapsed group, so the
 *  user can tell what's hidden without expanding. Caps at 4 names. */
function toolPeek(messages: ChatMessage[]): string {
  const names = messages
    .map(toolCardTitle)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return "";
  const shown = names.slice(0, 4).join(" · ");
  return names.length > 4 ? `${shown} · …` : shown;
}

/** Collapsed cluster of completed tool-call cards (tool visibility =
 *  "group-run" / "group-turn"). One disclosure row labelled "N tool calls"
 *  with a name peek, expanding to the individual cards. Expansion is local UI
 *  state in VirtualMessageList. */
function ToolGroupRow({
  group,
  state,
  tabId,
  expanded,
  onToggle,
}: {
  group: Extract<MessageGroup, { type: "tool-group" }>;
  state: Record<string, unknown>;
  tabId?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const count = group.messages.length;
  const peek = toolPeek(group.messages);
  return (
    <div className="ae-tool-group" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="ae-tool-group-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ae-tool-group-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="ae-tool-group-label">{count} tool calls</span>
        {!expanded && peek && (
          <span className="ae-tool-group-peek">{peek}</span>
        )}
      </button>
      {expanded && (
        <div className="ae-tool-group-body">
          {group.messages.map((m) =>
            m.a2ui ? (
              <A2UIRenderer
                key={m.id}
                payload={m.a2ui}
                state={state}
                tabId={tabId}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** Header label for a folded agent turn: "N replies · M tool calls". Counts
 *  only text-bearing non-tool messages as replies — a thinking-only message
 *  may render nothing when thinking is hidden, so it shouldn't inflate the
 *  count. */
function turnBlockLabel(messages: ChatMessage[]): string {
  const tools = messages.filter(isToolCardMessage).length;
  const replies = messages.filter(
    (m) => !isToolCardMessage(m) && Boolean(m.text),
  ).length;
  const parts: string[] = [];
  if (replies > 0) {
    parts.push(`${replies} ${replies === 1 ? "reply" : "replies"}`);
  }
  parts.push(`${tools} ${tools === 1 ? "tool call" : "tool calls"}`);
  return parts.join(" · ");
}

/** A whole completed agent turn folded into one collapsible block (tool
 *  visibility = "group-block"). Expands to the turn's messages — narration and
 *  tool cards — rendered in order via ChatMessageRow. */
function TurnBlockRow({
  group,
  state,
  tabId,
  onEvent,
  rowClassName,
  thinkingVisibility,
  expanded,
  onToggle,
}: {
  group: Extract<MessageGroup, { type: "turn-block" }>;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  rowClassName: string;
  thinkingVisibility: VisibilityMode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const peek = toolPeek(group.messages);
  return (
    <div className="ae-turn-block" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="ae-turn-block-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="ae-turn-block-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="ae-turn-block-label">Agent turn</span>
        <span className="ae-turn-block-meta">
          {turnBlockLabel(group.messages)}
        </span>
        {!expanded && peek && (
          <span className="ae-turn-block-peek">{peek}</span>
        )}
      </button>
      {expanded && (
        <div className="ae-turn-block-body">
          {group.messages.map((m, i) => (
            <ChatMessageRow
              key={m.id}
              message={m}
              state={state}
              tabId={tabId}
              className={rowClassName}
              prevRole={i > 0 ? group.messages[i - 1].role : undefined}
              onEvent={onEvent}
              thinkingVisibility={thinkingVisibility}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface VirtualMessageListProps {
  messages: ChatMessage[];
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  rowClassName?: string;
  /** Class for Virtuoso's scroller — the former scroll container. */
  className: string;
  scrollToMatch?: string;
  footerContext?: CanvasFooterContext;
  /** Resolved per-tab transcript visibility (thinking + tool calls). */
  visibility: ResolvedVisibility;
}

/** Virtualized chat feed. Replaces the old hand-rolled window + useStickyScroll:
 *  Virtuoso mounts only the visible rows (long histories no longer pin 160+
 *  markdown subtrees in the DOM) and owns stick-to-bottom via `followOutput`,
 *  the at-bottom signal for the pill, and index scrolling for search matches. */
function VirtualMessageList({
  messages,
  state,
  tabId,
  onEvent,
  rowClassName = "a2ui-chat-message",
  className,
  scrollToMatch,
  footerContext,
  visibility,
}: VirtualMessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [canScroll, setCanScroll] = useState(false);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const followLatestRef = useRef(true);
  const [followLatest, setFollowLatestState] = useState(true);
  const programmaticScrollUntilRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const prevScrollToMatch = useRef<string | undefined>(undefined);
  const queuedLabels = useMemo(
    () => queuedDeliveryLabels(messages),
    [messages],
  );
  // Tool-call visibility transforms the flat list into render groups: `show`
  // → one single per message, `hide` → tool cards dropped, and the grouped
  // modes fold tool cards into expandable clusters (`group-run` / `group-turn`
  // → tool-group rows) or whole turns into one block (`group-block` →
  // turn-block rows). Virtuoso renders groups, so its data length / keys track
  // groups, not raw messages.
  const groups = useMemo(
    () => groupMessages(messages, visibility.toolCalls),
    [messages, visibility.toolCalls],
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setFollowLatest = useCallback((next: boolean) => {
    followLatestRef.current = next;
    setFollowLatestState(next);
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = Math.max(
      programmaticScrollUntilRef.current,
      Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS,
    );
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
    programmaticScrollUntilRef.current = 0;
  }, []);

  const updateCanScroll = useCallback(() => {
    const el = scrollerElRef.current;
    setCanScroll(
      Boolean(
        el && el.scrollHeight - el.clientHeight > DEFAULT_AT_BOTTOM_THRESHOLD,
      ),
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    markProgrammaticScroll();
    virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
  }, [markProgrammaticScroll]);

  const updateFollowFromScroller = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom = metricsAreAtBottom(
      {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      },
      DEFAULT_AT_BOTTOM_THRESHOLD,
    );
    const isProgrammaticFollowScroll =
      Date.now() < programmaticScrollUntilRef.current &&
      !userScrollIntentRef.current;

    updateCanScroll();

    if (isProgrammaticFollowScroll) {
      if (atBottom) {
        programmaticScrollUntilRef.current = 0;
        setFollowLatest(true);
        setIsAtBottom(true);
      }
      return;
    }

    userScrollIntentRef.current = false;
    setFollowLatest(atBottom);
    setIsAtBottom(atBottom);
  }, [setFollowLatest, updateCanScroll]);

  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      if (scrollerElRef.current) {
        scrollerElRef.current.removeEventListener(
          "scroll",
          updateFollowFromScroller,
        );
        removeUserScrollIntentListeners(
          scrollerElRef.current,
          markUserScrollIntent,
        );
      }
      const el =
        typeof HTMLElement !== "undefined" && ref instanceof HTMLElement
          ? ref
          : null;
      scrollerElRef.current = el;
      if (el) {
        el.addEventListener("scroll", updateFollowFromScroller, {
          passive: true,
        });
        addUserScrollIntentListeners(el, markUserScrollIntent);
      }
      updateCanScroll();
    },
    [markUserScrollIntent, updateCanScroll, updateFollowFromScroller],
  );

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      updateCanScroll();
      if (atBottom) {
        programmaticScrollUntilRef.current = 0;
        setFollowLatest(true);
        setIsAtBottom(true);
      } else if (!followLatestRef.current) {
        setIsAtBottom(false);
      }
    },
    [setFollowLatest, updateCanScroll],
  );

  useEffect(
    () => () => {
      if (scrollerElRef.current) {
        scrollerElRef.current.removeEventListener(
          "scroll",
          updateFollowFromScroller,
        );
        removeUserScrollIntentListeners(
          scrollerElRef.current,
          markUserScrollIntent,
        );
      }
    },
    [markUserScrollIntent, updateFollowFromScroller],
  );

  // Jump to the newest message matching the search needle and flash it. Virtuoso
  // mounts the target row even when it's far offscreen, so no DOM walk is needed.
  useEffect(() => {
    if (!scrollToMatch || scrollToMatch === prevScrollToMatch.current) return;
    prevScrollToMatch.current = scrollToMatch;
    const needle = scrollToMatch.toLowerCase();
    // Search runs over groups so the scroll index matches Virtuoso's data.
    // Only text-bearing single rows can match (tool clusters carry no text).
    const idx = groups.findIndex(
      (g) =>
        g.type === "single" &&
        (g.message.text ?? "").toLowerCase().includes(needle),
    );
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- transient flash driven by an external search action (the same effect also imperatively scrolls); not derivable during render
    setFlashIndex(idx);
    const timer = window.setTimeout(() => setFlashIndex(null), 1200);
    return () => window.clearTimeout(timer);
  }, [groups, scrollToMatch]);

  const itemContent = useCallback(
    (index: number, group: MessageGroup) => {
      // flow-root establishes a BFC so the row's vertical margins (role-change
      // spacing, etc.) are CONTAINED in this wrapper rather than collapsing
      // through it. Virtuoso measures the wrapper, so the margins are counted —
      // bare margins on the row would escape measurement and drift the
      // follow-to-bottom / scrollToIndex offsets in long transcripts.
      const rowClass = `a2ui-msg-row${index === 0 ? " a2ui-msg-row-first" : ""}${
        index === groups.length - 1 ? " a2ui-msg-row-last" : ""
      }`;
      if (group.type === "tool-group") {
        return (
          <div className={rowClass}>
            <ToolGroupRow
              group={group}
              state={state}
              tabId={tabId}
              expanded={expandedGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
            />
          </div>
        );
      }
      if (group.type === "turn-block") {
        return (
          <div className={rowClass}>
            <TurnBlockRow
              group={group}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
              rowClassName={rowClassName}
              thinkingVisibility={visibility.thinking}
              expanded={expandedGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
            />
          </div>
        );
      }
      const m = group.message;
      // prevRole drives role-badge suppression on consecutive same-role rows.
      // A preceding tool cluster reads as an agent turn, so it counts as
      // "agent" for that purpose.
      const prev = groups[index - 1];
      const prevRole = prev
        ? prev.type === "single"
          ? prev.message.role
          : "agent"
        : undefined;
      return (
        <div className={rowClass}>
          <ChatMessageRow
            message={m}
            state={state}
            tabId={tabId}
            className={
              index === flashIndex
                ? `${rowClassName} a2ui-chat-message-flash`
                : rowClassName
            }
            prevRole={prevRole}
            onEvent={onEvent}
            deliveryText={queuedLabels.get(m.id)}
            isLatest={index === groups.length - 1}
            thinkingVisibility={visibility.thinking}
          />
        </div>
      );
    },
    [
      groups,
      state,
      tabId,
      rowClassName,
      flashIndex,
      onEvent,
      queuedLabels,
      visibility.thinking,
      expandedGroups,
      toggleGroup,
    ],
  );

  // Only wire `context`/`components` when there's a footer. Passing
  // `components={undefined}` explicitly trips Virtuoso's internal
  // `components.EmptyPlaceholder` access, so omit the props entirely otherwise.
  const footerProps = footerContext
    ? { context: footerContext, components: { Footer: CanvasFooter } }
    : {};

  // The canvas can be scrollable with zero messages (a live subtree / typing
  // indicator in the Footer), so the pill must consider footer content too.
  const hasFooterContent = Boolean(
    footerContext && (footerContext.liveSubtree || footerContext.showTyping),
  );
  const hasContent = messages.length > 0 || hasFooterContent;
  const latestMessage = messages.at(-1);
  const latestStreamingFences =
    latestMessage?.role === "agent" &&
    state.waiting === true &&
    hasFencedCodeMarker(latestMessage.text);

  const handleFollowOutput = useCallback(() => {
    if (!followLatestRef.current) return false;
    markProgrammaticScroll();
    return latestStreamingFences ? "auto" : "smooth";
  }, [latestStreamingFences, markProgrammaticScroll]);

  const handleTotalListHeightChanged = useCallback(() => {
    updateCanScroll();
    if (followLatestRef.current) scrollToBottom();
  }, [scrollToBottom, updateCanScroll]);

  // Tool grouping and streamed thinking frequently change row keys/counts or
  // measured heights without a simple "new last item appended" signal. When
  // follow intent is still enabled, explicitly pin the scroller after React has
  // committed the new rows; when the user has scrolled away, `followLatest`
  // stays false and this path is inert.
  useLayoutEffect(() => {
    updateCanScroll();
    if (!followLatest) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [
    expandedGroups,
    followLatest,
    footerContext,
    groups,
    messages,
    scrollToBottom,
    updateCanScroll,
    visibility.thinking,
  ]);

  return (
    <div className="a2ui-msg-list-shell">
      <Virtuoso
        ref={virtuosoRef}
        className={className}
        style={{ flex: 1, minHeight: 0 }}
        data={groups}
        computeItemKey={(index, g) => (g ? groupKey(g) : String(index))}
        itemContent={itemContent}
        // Open scrolled to the BOTTOM of the newest message. `align: "end"`
        // pins the last item's bottom to the viewport bottom — a bare index
        // aligns it to the top, so a tall final message would open at its start
        // instead of the latest content (the old scrollTop=scrollHeight
        // contract). Do NOT also pass `initialItemCount`: combined with a bottom
        // index Virtuoso requests rows past the end of `data` and feeds
        // `undefined` into computeItemKey, crashing on m.id for any restored 2+
        // message chat (see message-list.virtuoso.test.tsx).
        initialTopMostItemIndex={{
          index: Math.max(0, groups.length - 1),
          align: "end",
        }}
        followOutput={followLatest ? handleFollowOutput : false}
        atBottomThreshold={DEFAULT_AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomStateChange}
        scrollerRef={handleScrollerRef}
        totalListHeightChanged={handleTotalListHeightChanged}
        {...footerProps}
      />
      <ScrollToBottomPill
        visible={!isAtBottom && canScroll && hasContent}
        onClick={() => {
          setFollowLatest(true);
          setIsAtBottom(true);
          // Scroll to the true bottom of the scroller, which includes the
          // Footer (live subtree / typing indicator) — scrollToIndex(last)
          // would stop at the last message, above a footer-only response.
          scrollToBottom();
        }}
      />
    </div>
  );
}

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

  const messages = useMemo(
    () => (resolvePointer(state, props.messages.$ref) as ChatMessage[]) || [],
    [props.messages.$ref, state],
  );
  const visibility = useMemo(
    () => resolveVisibility(state, tabId),
    [state, tabId],
  );
  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "Start a conversation.";

  const scrollToMatchByTab =
    (state.scrollToMatchByTab as Record<string, string> | undefined) ?? {};
  const scrollToMatch = tabId ? scrollToMatchByTab[tabId] : undefined;

  if (messages.length === 0) {
    return (
      <div className="a2ui-chat-history a2ui-chat-history-empty">
        <div className="a2ui-chat-empty">{emptyHint}</div>
      </div>
    );
  }

  return (
    <VirtualMessageList
      className="a2ui-chat-history"
      messages={messages}
      state={state}
      tabId={tabId}
      onEvent={onEvent}
      scrollToMatch={scrollToMatch}
      visibility={visibility}
    />
  );
}

export function MainCanvas({
  component,
  state,
  tabId,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    slot?: string;
    messages?: { $ref: string };
    emptyHint?: StringValue;
  };

  const chatMode = props.messages !== undefined;
  const messages = useMemo(
    () =>
      chatMode
        ? (resolvePointer(state, props.messages!.$ref) as ChatMessage[]) || []
        : [],
    [chatMode, props.messages, state],
  );

  const visibility = useMemo(
    () => resolveVisibility(state, tabId),
    [state, tabId],
  );

  const live = props.slot ? resolvePointer(state, props.slot) : null;
  const liveSubtree =
    live && typeof live === "object" && "components" in live
      ? (live as { components: A2UIComponent[] })
      : null;

  const emptyHint = props.emptyHint
    ? resolveString(props.emptyHint, state)
    : "The agent's canvas is empty. Send a message to populate it.";

  // Non-chat canvas: the agent fully owns this surface, no message feed.
  if (!chatMode) {
    return (
      <main className="a2ui-canvas a2ui-canvas-bare">
        {liveSubtree && (
          <div className="a2ui-canvas-live">
            <A2UIRenderer payload={liveSubtree} state={state} tabId={tabId} />
          </div>
        )}
      </main>
    );
  }

  // Empty chat canvas with nothing live yet — just the hint.
  if (messages.length === 0 && !liveSubtree) {
    return (
      <main className="a2ui-canvas a2ui-canvas-empty-host">
        <div className="a2ui-canvas-empty">{emptyHint}</div>
      </main>
    );
  }

  const footerContext: CanvasFooterContext = {
    liveSubtree,
    showTyping: state.waiting === true && !liveSubtree && messages.length > 0,
    state,
    tabId,
  };

  return (
    <main className="a2ui-canvas a2ui-canvas-host">
      <VirtualMessageList
        className="a2ui-canvas-scroller"
        rowClassName="a2ui-canvas-message"
        messages={messages}
        state={state}
        tabId={tabId}
        onEvent={onEvent}
        footerContext={footerContext}
        visibility={visibility}
      />
    </main>
  );
}
