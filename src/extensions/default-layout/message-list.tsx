import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  CHAT_MARKDOWN_PROPS,
  CHAT_STREAMING_MARKDOWN_PROPS,
} from "./markdown-adapter";
import { isAtBottom as metricsAreAtBottom } from "../../utils/stickyScrollController";
import { ImageAttachmentImage } from "./image-attachment-image";
import { ImageLightbox } from "./image-lightbox";

// Distance (px) from the bottom still treated as "at the bottom" for follow +
// the scroll-to-bottom pill. Matches the old StickyScrollController default.
const DEFAULT_AT_BOTTOM_THRESHOLD = 60;
const FENCED_CODE_MARKER_RE = /(^|\n)(```|~~~)/;

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
}: {
  children: string;
  complete?: boolean;
}) {
  const label = complete ? "Thinking" : "Thinking...";
  return (
    <details className="a2ui-thinking-block" open={!complete}>
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
}: {
  text: string;
  streamingFences?: boolean;
}) {
  const markdownProps = streamingFences
    ? CHAT_STREAMING_MARKDOWN_PROPS
    : CHAT_MARKDOWN_PROPS;
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

const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    state,
    tabId,
    className = "a2ui-chat-message",
    prevRole,
    onEvent,
    deliveryText,
    isLatest,
  }: {
    message: ChatMessage;
    state: Record<string, unknown>;
    tabId?: string;
    className?: string;
    prevRole?: string;
    onEvent?: BuiltinComponentProps["onEvent"];
    deliveryText?: string;
    isLatest?: boolean;
  }) {
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
        {message.thinking && (
          <ThinkingBlock complete={Boolean(message.text)}>
            {message.thinking}
          </ThinkingBlock>
        )}
        {message.text && (
          <div className={textClass}>
            <MemoMarkdownWithThinking
              text={message.text}
              streamingFences={streamingFences}
            />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentGallery attachments={message.attachments} />
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
}: VirtualMessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [canScroll, setCanScroll] = useState(false);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const followLatestRef = useRef(true);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const prevScrollToMatch = useRef<string | undefined>(undefined);
  const queuedLabels = useMemo(
    () => queuedDeliveryLabels(messages),
    [messages],
  );
  const updateCanScroll = useCallback(() => {
    const el = scrollerElRef.current;
    setCanScroll(
      Boolean(
        el && el.scrollHeight - el.clientHeight > DEFAULT_AT_BOTTOM_THRESHOLD,
      ),
    );
  }, []);

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
    followLatestRef.current = atBottom;
    setIsAtBottom(atBottom);
    updateCanScroll();
  }, [updateCanScroll]);

  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      if (scrollerElRef.current) {
        scrollerElRef.current.removeEventListener(
          "scroll",
          updateFollowFromScroller,
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
      }
      updateCanScroll();
    },
    [updateCanScroll, updateFollowFromScroller],
  );

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      updateCanScroll();
      if (atBottom) {
        followLatestRef.current = true;
        setIsAtBottom(true);
      } else if (!followLatestRef.current) {
        setIsAtBottom(false);
      }
    },
    [updateCanScroll],
  );

  useEffect(
    () => () => {
      if (scrollerElRef.current) {
        scrollerElRef.current.removeEventListener(
          "scroll",
          updateFollowFromScroller,
        );
      }
    },
    [updateFollowFromScroller],
  );

  // Jump to the newest message matching the search needle and flash it. Virtuoso
  // mounts the target row even when it's far offscreen, so no DOM walk is needed.
  useEffect(() => {
    if (!scrollToMatch || scrollToMatch === prevScrollToMatch.current) return;
    prevScrollToMatch.current = scrollToMatch;
    const needle = scrollToMatch.toLowerCase();
    const idx = messages.findIndex((m) =>
      (m.text ?? "").toLowerCase().includes(needle),
    );
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- transient flash driven by an external search action (the same effect also imperatively scrolls); not derivable during render
    setFlashIndex(idx);
    const timer = window.setTimeout(() => setFlashIndex(null), 1200);
    return () => window.clearTimeout(timer);
  }, [messages, scrollToMatch]);

  const itemContent = useCallback(
    (index: number, m: ChatMessage) => (
      // flow-root establishes a BFC so the row's vertical margins (role-change
      // spacing, etc.) are CONTAINED in this wrapper rather than collapsing
      // through it. Virtuoso measures the wrapper, so the margins are counted —
      // bare margins on the row would escape measurement and drift the
      // follow-to-bottom / scrollToIndex offsets in long transcripts.
      <div
        className={`a2ui-msg-row${index === 0 ? " a2ui-msg-row-first" : ""}${
          index === messages.length - 1 ? " a2ui-msg-row-last" : ""
        }`}
      >
        <ChatMessageRow
          message={m}
          state={state}
          tabId={tabId}
          className={
            index === flashIndex
              ? `${rowClassName} a2ui-chat-message-flash`
              : rowClassName
          }
          prevRole={index > 0 ? messages[index - 1].role : undefined}
          onEvent={onEvent}
          deliveryText={queuedLabels.get(m.id)}
          isLatest={index === messages.length - 1}
        />
      </div>
    ),
    [state, tabId, rowClassName, flashIndex, messages, onEvent, queuedLabels],
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

  return (
    <div className="a2ui-msg-list-shell">
      <Virtuoso
        ref={virtuosoRef}
        className={className}
        style={{ flex: 1, minHeight: 0 }}
        data={messages}
        computeItemKey={(_index, m) => m.id}
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
          index: Math.max(0, messages.length - 1),
          align: "end",
        }}
        followOutput={() =>
          followLatestRef.current
            ? latestStreamingFences
              ? "auto"
              : "smooth"
            : false
        }
        atBottomThreshold={DEFAULT_AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomStateChange}
        scrollerRef={handleScrollerRef}
        totalListHeightChanged={updateCanScroll}
        {...footerProps}
      />
      <ScrollToBottomPill
        visible={!isAtBottom && canScroll && hasContent}
        onClick={() => {
          followLatestRef.current = true;
          setIsAtBottom(true);
          // Scroll to the true bottom of the scroller, which includes the
          // Footer (live subtree / typing indicator) — scrollToIndex(last)
          // would stop at the last message, above a footer-only response.
          virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
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
      />
    </main>
  );
}
