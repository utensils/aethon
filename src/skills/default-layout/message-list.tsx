import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import type {
  A2UIComponent,
  ChatMessage,
  StringValue,
} from "../../types/a2ui";
import A2UIRenderer from "../../components/A2UIRenderer";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";
import { useStickyScroll } from "../../utils/useStickyScroll";
import {
  CHAT_MARKDOWN_COMPONENTS,
  MARKDOWN_REMARK_PLUGINS,
} from "./markdown-adapter";

const INITIAL_VISIBLE_MESSAGES = 160;
const MESSAGE_PAGE_SIZE = 120;

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
        <ReactMarkdown
          components={CHAT_MARKDOWN_COMPONENTS}
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        >
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
          <ReactMarkdown
            key={index}
            components={CHAT_MARKDOWN_COMPONENTS}
            remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          >
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

function useMessageWindow(messages: ChatMessage[]) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleCount)),
    [messages, visibleCount],
  );
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);

  useEffect(() => {
    if (messages.length < visibleCount) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination when history shrinks after tab switch or clear
      setVisibleCount(INITIAL_VISIBLE_MESSAGES);
    }
  }, [messages.length, visibleCount]);

  return {
    visibleCount,
    visibleMessages,
    hiddenCount,
    loadOlder: () =>
      setVisibleCount((n) => Math.min(messages.length, n + MESSAGE_PAGE_SIZE)),
    showFrom: Math.max(0, messages.length - visibleMessages.length),
    setVisibleCount,
  };
}

interface MessageListProps {
  messages: ChatMessage[];
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
  rowClassName?: string;
  containerRef: RefObject<HTMLElement | null>;
  scrollToMatch?: string;
}

function MessageList({
  messages,
  state,
  tabId,
  onEvent,
  rowClassName = "a2ui-chat-message",
  containerRef,
  scrollToMatch,
}: MessageListProps) {
  const { visibleMessages, hiddenCount, loadOlder, showFrom, setVisibleCount } =
    useMessageWindow(messages);
  const queuedLabels = useMemo(() => queuedDeliveryLabels(messages), [messages]);
  const prevScrollToMatch = useRef<string | undefined>(undefined);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollToMatch || scrollToMatch === prevScrollToMatch.current) {
      return;
    }
    prevScrollToMatch.current = scrollToMatch;
    const needle = scrollToMatch.toLowerCase();
    const idx = messages.findIndex((m) =>
      (m.text ?? "").toLowerCase().includes(needle),
    );
    if (idx < 0) return;
    const scrollRowIntoView = (offset: number) => {
      const row = el.querySelectorAll(`.${rowClassName}`)[offset];
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: "center", behavior: "auto" });
        row.classList.add("a2ui-chat-message-flash");
        window.setTimeout(
          () => row.classList.remove("a2ui-chat-message-flash"),
          1200,
        );
      }
    };
    if (idx < showFrom) {
      window.setTimeout(() => {
        setVisibleCount(messages.length - idx);
        scrollRowIntoView(0);
      }, 0);
    } else {
      scrollRowIntoView(idx - showFrom);
    }
  }, [
    containerRef,
    messages,
    rowClassName,
    scrollToMatch,
    setVisibleCount,
    showFrom,
  ]);

  return (
    <>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="a2ui-chat-load-older"
          onClick={loadOlder}
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
          className={rowClassName}
          prevRole={i > 0 ? visibleMessages[i - 1].role : undefined}
          onEvent={onEvent}
          deliveryText={queuedLabels.get(m.id)}
        />
      ))}
    </>
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

  const listRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(listRef);

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

  const prevLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== prevLength.current) {
      prevLength.current = messages.length;
      handleContentChanged();
    }
  }, [messages.length, handleContentChanged]);

  return (
    <div className="a2ui-chat-history" ref={listRef}>
      {messages.length === 0 ? (
        <div className="a2ui-chat-empty">{emptyHint}</div>
      ) : (
        <MessageList
          messages={messages}
          state={state}
          tabId={tabId}
          onEvent={onEvent}
          containerRef={listRef}
          scrollToMatch={scrollToMatch}
        />
      )}
      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />
    </div>
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

  const listRef = useRef<HTMLElement>(null);
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

  return (
    <main
      className={chatMode ? "a2ui-canvas" : "a2ui-canvas a2ui-canvas-bare"}
      ref={listRef}
    >
      {chatMode && messages.length === 0 && !liveSubtree && (
        <div className="a2ui-canvas-empty">{emptyHint}</div>
      )}
      {chatMode && (
        <MessageList
          messages={messages}
          state={state}
          tabId={tabId}
          onEvent={onEvent}
          rowClassName="a2ui-canvas-message"
          containerRef={listRef}
        />
      )}
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
