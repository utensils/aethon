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
import { Virtuoso, type VirtuosoHandle, type ListRange } from "react-virtuoso";
import type {
  A2UIComponent,
  ChatAttachment,
  ChatMessage,
  StringValue,
} from "../../types/a2ui";
import A2UIRenderer from "../../components/A2UIRenderer";
import type {
  A2UIEventHandler,
  BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import { resolveString } from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";
import { normalizeAgentMessageForDisplay } from "../../utils/agentResponseNormalizer";
import {
  resolveVisibility,
  type ResolvedVisibility,
} from "../../utils/visibilityResolver";
import {
  groupMessages,
  groupKey,
  isToolCardMessage,
  anchorMessageIdForGroup,
  findGroupIndexForMessageId,
  type MessageGroup,
} from "../../utils/toolCardGrouping";
import type { VisibilityMode } from "../../config";
import {
  CHAT_MARKDOWN_PROPS,
  CHAT_STREAMING_MARKDOWN_PROPS,
} from "./markdown-adapter";
import { isAtBottom as metricsAtBottom } from "../../utils/stickyScrollController";
import { ImageAttachmentImage } from "./image-attachment-image";
import { ImageLightbox } from "./image-lightbox";

// Distance (px) from the bottom still treated as "at the bottom" — used by the
// scroll handler's metricsAtBottom check (follow on/off) and the canScroll
// overflow check that gates the scroll-to-bottom pill.
const DEFAULT_AT_BOTTOM_THRESHOLD = 60;
const FENCED_CODE_MARKER_RE = /(^|\n)(```|~~~)/;

function forwardNestedA2UIEvent(
  onEvent: BuiltinComponentProps["onEvent"] | undefined,
): A2UIEventHandler {
  return (component, eventType, data) => {
    onEvent?.(eventType, data, component.id);
    return eventType === "tool-file-open" || eventType === "tool-file-diff";
  };
}

// tabId → the message id at the top of the viewport when the tab was left
// scrolled-up (absent when it was left following at the bottom). The message
// list is keyed by tab id (see ChatHistory / MainCanvas), so each tab mounts its
// own Virtuoso instance; on the next mount we map this id back to its current
// row index and open there via initialTopMostItemIndex. Keyed by message id, not
// pixels, so it survives new messages arriving while the tab is backgrounded and
// avoids react-virtuoso's fragile getState/restoreStateFrom scrollTop timing.
// Module-level so it survives the keyed remount.
const tabScrollCache = new Map<string, string>();

// Follow state must flip only on a genuine USER scroll, never on the
// programmatic re-pins we issue while following (those would otherwise be read
// back as "the user scrolled"). Content reflow/growth does NOT fire a scroll
// event, so the only scroll events to disambiguate are user gestures vs our own
// scrollTo. We mark a user gesture (wheel / touch / scroll-key) and let the
// resulting scroll event recompute follow; un-gestured scroll events (our
// re-pins) are ignored. This is what makes a scroll-away win the race against an
// in-flight streaming re-pin.
const USER_SCROLL_INTENT_EVENTS = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
] as const;
const SCROLL_INTENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "button,a,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[tabindex]:not([tabindex='-1'])",
    ),
  );
}

function isUserScrollIntentEvent(event: Event): boolean {
  if (!(event instanceof KeyboardEvent)) return true;
  if (!SCROLL_INTENT_KEYS.has(event.key)) return false;
  if (isInteractiveKeyboardTarget(event.target)) return false;
  return true;
}

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
    const displayMessage = normalizeAgentMessageForDisplay(message);
    // Rollback / fork are offered on real user/assistant turns that carry a pi
    // entry id (tool-card and system rows are not branch targets). Thinking-only
    // turns count too — they're valid branch points.
    const canBranch =
      Boolean(message.entryId) &&
      (message.role === "user" || message.role === "agent") &&
      (Boolean(displayMessage.text) || Boolean(displayMessage.thinking)) &&
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
      hasFencedCodeMarker(displayMessage.text);
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
        {displayMessage.thinking && thinkingVisibility !== "hide" && (
          <ThinkingBlock
            complete={Boolean(displayMessage.text)}
            collapsed={thinkingVisibility === "collapse"}
          >
            {displayMessage.thinking}
          </ThinkingBlock>
        )}
        {displayMessage.text && (
          <div className={textClass}>
            <MemoMarkdownWithThinking
              text={displayMessage.text}
              streamingFences={streamingFences}
              thinkingVisibility={thinkingVisibility}
            />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentGallery attachments={message.attachments} />
        )}
        {message.a2ui && (
          <A2UIRenderer
            payload={message.a2ui}
            state={state}
            onEvent={forwardNestedA2UIEvent(onEvent)}
            tabId={tabId}
          />
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
  onEvent,
  expanded,
  onToggle,
}: {
  group: Extract<MessageGroup, { type: "tool-group" }>;
  state: Record<string, unknown>;
  tabId?: string;
  onEvent?: BuiltinComponentProps["onEvent"];
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
                onEvent={forwardNestedA2UIEvent(onEvent)}
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

/** Virtualized chat feed. Virtuoso mounts only the visible rows (long histories
 *  no longer pin 160+ markdown subtrees in the DOM). Stick-to-bottom has a
 *  SINGLE owner — the `following` flag in this component, NOT Virtuoso (its
 *  `followOutput` is disabled). Follow flips only on a user-gestured scroll;
 *  while following, content growth re-pins via `totalListHeightChanged` →
 *  instant `scrollTo`. `scrollToIndex` handles search jumps, filter-toggle
 *  re-anchoring, and per-tab restore. No competing scroller. */
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
  // `following` drives the pill (render); `followingRef` is the synchronous
  // source of truth the re-pin + filter effects read. They move together via
  // setFollowing(). This flag is the single owner of stick-to-bottom intent.
  // A cached snapshot exists only for a tab left scrolled-up (see handleScroll),
  // so seed follow=false when restoring one — otherwise default to following.
  const initialFollowing = !(tabId !== undefined && tabScrollCache.has(tabId));
  const [following, setFollowingState] = useState(initialFollowing);
  const followingRef = useRef(initialFollowing);
  const [canScroll, setCanScroll] = useState(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Set by a user gesture (wheel/touch/scroll-key); the next scroll event reads
  // and clears it. Distinguishes a real scroll-away from our own re-pins.
  const userScrollRef = useRef(false);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const prevScrollToMatch = useRef<string | undefined>(undefined);
  const prevLastMessageId = useRef(messages[messages.length - 1]?.id);
  // Topmost visible group index, fed by Virtuoso's rangeChanged — used to
  // recover the reading anchor when a filter toggle rebuilds the group list.
  const lastRangeRef = useRef<ListRange | null>(null);
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
  // Always-current groups for synchronous reads inside event handlers (scroll /
  // rangeChanged), which fire outside the render that produced `groups`. Synced
  // in a layout effect (refs must not be written during render); event handlers
  // run after commit, so the ref is current by the time they fire.
  const groupsRef = useRef(groups);
  useLayoutEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
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
  const prevGroupsRef = useRef<MessageGroup[]>(groups);
  const prevVisRef = useRef({
    toolCalls: visibility.toolCalls,
    thinking: visibility.thinking,
  });
  const terminalOpen = Boolean(
    (state.terminal as { open?: boolean } | undefined)?.open,
  );
  const layoutRows =
    (state.layout as { rows?: unknown } | undefined)?.rows ?? null;

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const updateCanScroll = useCallback(() => {
    const el = scrollerElRef.current;
    setCanScroll(
      Boolean(
        el && el.scrollHeight - el.clientHeight > DEFAULT_AT_BOTTOM_THRESHOLD,
      ),
    );
  }, []);

  const scrollToBottom = useCallback((settleMs = 150) => {
    // Scroll to the true bottom of the scroller — this includes the footer's
    // live subtree / typing indicator, which sit below the last data row.
    const pinDomScroller = () => {
      const lastIndex = Math.max(0, groupsRef.current.length - 1);
      virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: "end" });
      virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
      const el = scrollerElRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    const pinIfStillFollowing = () => {
      if (followingRef.current) pinDomScroller();
    };
    pinDomScroller();
    const startedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();
    const now = () =>
      typeof performance === "undefined" ? Date.now() : performance.now();
    const frame = () => {
      if (!followingRef.current) return;
      pinDomScroller();
      if (now() - startedAt < settleMs) window.requestAnimationFrame(frame);
    };
    window.requestAnimationFrame(frame);
    for (const delay of [50, 150, 300, 600, 900]) {
      if (delay <= settleMs) window.setTimeout(pinIfStillFollowing, delay);
    }
  }, []);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (isUserScrollIntentEvent(event)) userScrollRef.current = true;
  }, []);

  // Sole follow on/off path. Only a gesture-flagged scroll recomputes follow
  // from the live position; un-flagged scroll events (our own re-pins) are
  // ignored. Because content reflow/growth fires no scroll event, follow can
  // never be flipped off by streaming — only by a real user scroll-away.
  const handleScroll = useCallback(() => {
    updateCanScroll();
    if (!userScrollRef.current) return;
    userScrollRef.current = false;
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom = metricsAtBottom(
      {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      },
      DEFAULT_AT_BOTTOM_THRESHOLD,
    );
    setFollowing(atBottom);
    // Per-tab scroll restore: remember the top-of-viewport message id while
    // scrolled-up; clear it when the user returns to the bottom (so the tab
    // reopens following at the live bottom). ONLY user-gestured scrolls touch
    // the cache — programmatic re-pins and the restore itself are un-gestured,
    // so a transient mount-time position (e.g. React StrictMode's dev remount)
    // can never clobber it. rangeChanged keeps this fresh as the user scrolls.
    if (tabId !== undefined) {
      if (atBottom) {
        tabScrollCache.delete(tabId);
      } else {
        const anchorId = anchorMessageIdForGroup(
          groupsRef.current[lastRangeRef.current?.startIndex ?? 0],
        );
        if (anchorId) tabScrollCache.set(tabId, anchorId);
      }
    }
  }, [setFollowing, tabId, updateCanScroll]);

  // Track the topmost visible group and, while scrolled-up, keep the per-tab
  // restore anchor current as the user scrolls (so switching away restores the
  // exact message they were reading, even after new messages arrived).
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      lastRangeRef.current = range;
      if (tabId !== undefined && !followingRef.current) {
        const anchorId = anchorMessageIdForGroup(
          groupsRef.current[range.startIndex],
        );
        if (anchorId) tabScrollCache.set(tabId, anchorId);
      }
    },
    [tabId],
  );

  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const prev = scrollerElRef.current;
      if (prev) {
        prev.removeEventListener("scroll", handleScroll);
        removeUserScrollIntentListeners(prev, markUserScrollIntent);
      }
      const el =
        typeof HTMLElement !== "undefined" && ref instanceof HTMLElement
          ? ref
          : null;
      scrollerElRef.current = el;
      setScrollerEl(el);
      if (el) {
        el.addEventListener("scroll", handleScroll, { passive: true });
        addUserScrollIntentListeners(el, markUserScrollIntent);
      }
      updateCanScroll();
    },
    [handleScroll, markUserScrollIntent, updateCanScroll],
  );

  // Content grew/shrank (append, streamed token, tool/thinking expand, late
  // reflow, footer). While following, re-pin to the bottom instantly. This is
  // the SOLE re-pin source — Virtuoso's own followOutput is disabled — so no
  // second scroller races it. Reflow that fires no scroll event is caught here,
  // which is what keeps a fresh mount (async highlight/markdown reflow) pinned.
  const handleTotalListHeightChanged = useCallback(() => {
    updateCanScroll();
    if (followingRef.current) scrollToBottom();
  }, [scrollToBottom, updateCanScroll]);

  // Detach the scroll listeners when the keyed instance unmounts (tab switch).
  // The per-tab snapshot is maintained live in handleScroll (gated to genuine
  // user scrolls), so there is deliberately NO getState-on-unmount here — that
  // would capture a transient pre-restore scrollTop under React StrictMode's
  // dev double-mount and clobber the cached position.
  useLayoutEffect(() => {
    return () => {
      const el = scrollerElRef.current;
      if (el) {
        el.removeEventListener("scroll", handleScroll);
        removeUserScrollIntentListeners(el, markUserScrollIntent);
      }
    };
  }, [handleScroll, markUserScrollIntent]);

  // Terminal open/resize changes the chat viewport height without changing the
  // list height, so Virtuoso's totalListHeightChanged callback never fires. If
  // the user is following the transcript, keep the bottom pinned through that
  // viewport resize; if they intentionally scrolled up, preserve their anchor.
  useLayoutEffect(() => {
    if (!scrollerEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateCanScroll();
      if (followingRef.current) scrollToBottom(900);
    });
    observer.observe(scrollerEl);
    return () => observer.disconnect();
  }, [scrollerEl, scrollToBottom, updateCanScroll]);

  // The workstation grid row string is the source of truth for terminal
  // open/close height. ResizeObserver is useful but not sufficient on WebKit:
  // repeated 0px ↔ Npx terminal toggles can leave Virtuoso visually unpinned
  // while our follow flag is still true. Treat the state transition itself as
  // a follow-preserving resize signal.
  useLayoutEffect(() => {
    if (followingRef.current) scrollToBottom(900);
  }, [layoutRows, scrollToBottom, scrollerEl, terminalOpen]);

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
              onEvent={onEvent}
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
  // Per-tab restore: map the saved top-of-viewport message id to its current row
  // index. When present, open there (aligned to the top); otherwise open pinned
  // to the bottom. These are mutually exclusive — a bottom initial index would
  // otherwise win over any restore.
  const restoreAnchorId =
    tabId !== undefined ? tabScrollCache.get(tabId) : undefined;
  const restoreIndex = restoreAnchorId
    ? findGroupIndexForMessageId(groups, restoreAnchorId)
    : -1;
  const initialIndex =
    restoreIndex >= 0
      ? { index: restoreIndex, align: "start" as const }
      : { index: Math.max(0, groups.length - 1), align: "end" as const };

  // A cached restore anchor that no longer exists (chat cleared via Cmd+K, or a
  // session rollback truncated it away) is stale: restoreIndex is -1 so the list
  // opens at the bottom, but `following` was seeded false — which would leave the
  // pill showing at the bottom with content-growth re-pins disabled. Drop the
  // stale entry and resume following at the live bottom.
  useLayoutEffect(() => {
    if (!restoreAnchorId || restoreIndex >= 0) return;
    if (tabId !== undefined) tabScrollCache.delete(tabId);
    if (!followingRef.current) {
      setFollowing(true);
      scrollToBottom();
    }
  }, [restoreAnchorId, restoreIndex, scrollToBottom, setFollowing, tabId]);

  // A new user turn is an explicit request to continue the conversation, so the
  // transcript should resume following even if the user had been reading above
  // the bottom before they sent it. Streaming output still respects manual
  // scroll-away because only a newly appended user message reaches this branch.
  // Batched updates can append the user message and the first agent/tool row in
  // one render, so scan everything appended after the previous tail instead of
  // checking only the latest row.
  useLayoutEffect(() => {
    const latest = messages[messages.length - 1];
    const previousId = prevLastMessageId.current;
    prevLastMessageId.current = latest?.id;
    if (!latest || latest.id === previousId) return;
    const previousIndex = previousId
      ? messages.findIndex((message) => message.id === previousId)
      : -1;
    const appended =
      previousIndex >= 0 ? messages.slice(previousIndex + 1) : messages;
    if (!appended.some((message) => message.role === "user")) return;
    if (tabId !== undefined) tabScrollCache.delete(tabId);
    if (!followingRef.current) setFollowing(true);
    scrollToBottom(900);
  }, [messages, scrollToBottom, setFollowing, tabId]);

  // Toggling a transcript filter (tool-call grouping / thinking visibility)
  // rebuilds `groups` with a different length + identity. Re-anchor exactly once
  // per toggle (NOT per streamed token — visibility is the guard) so the view
  // never jumps: a following user stays pinned to the new bottom; a scrolled-up
  // user keeps the message they were reading in place.
  useLayoutEffect(() => {
    const prevVis = prevVisRef.current;
    const prevGroups = prevGroupsRef.current;
    const visChanged =
      prevVis.toolCalls !== visibility.toolCalls ||
      prevVis.thinking !== visibility.thinking;
    prevVisRef.current = {
      toolCalls: visibility.toolCalls,
      thinking: visibility.thinking,
    };
    prevGroupsRef.current = groups;
    if (!visChanged) return;

    if (followingRef.current) {
      scrollToBottom();
      return;
    }

    // Map the topmost visible message id from the OLD groups to its index in
    // the NEW groups and pin it to the top (preserves the reading position).
    const startIndex = lastRangeRef.current?.startIndex ?? 0;
    const anchorId = anchorMessageIdForGroup(prevGroups[startIndex]);
    let newIndex = findGroupIndexForMessageId(groups, anchorId);
    if (newIndex < 0 && anchorId) {
      // Anchor dropped (e.g. its tool card was hidden): fall back to the nearest
      // preceding message that still survives in the new groups.
      const anchorMsgIdx = messages.findIndex((m) => m.id === anchorId);
      for (let i = anchorMsgIdx - 1; i >= 0; i--) {
        const idx = findGroupIndexForMessageId(groups, messages[i].id);
        if (idx >= 0) {
          newIndex = idx;
          break;
        }
      }
    }
    if (newIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: newIndex, align: "start" });
    }
  }, [
    groups,
    messages,
    scrollToBottom,
    visibility.thinking,
    visibility.toolCalls,
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
        // Open at the saved per-tab anchor (top-aligned) when restoring a
        // scrolled-up tab, else pinned to the BOTTOM of the newest message.
        // `align: "end"` pins the last item's bottom to the viewport bottom — a
        // bare index aligns to the top, so a tall final message would open at
        // its start instead of the latest content. Do NOT also pass
        // `initialItemCount`: combined with a bottom index Virtuoso requests
        // rows past the end of `data` and feeds `undefined` into computeItemKey,
        // crashing on m.id for any restored 2+ message chat (see
        // message-list.virtuoso.test.tsx).
        initialTopMostItemIndex={initialIndex}
        // followOutput is intentionally OFF: our controller is the single
        // scroller (via totalListHeightChanged), so Virtuoso never auto-scrolls
        // and there is no second source of truth to race. Disabling it also
        // disables Virtuoso's internal size-change re-pin, which proved
        // unreliable (it re-pins only in brief windows and emitted a spurious
        // not-at-bottom after late mount reflow, freezing the pill on).
        followOutput={false}
        rangeChanged={handleRangeChanged}
        scrollerRef={handleScrollerRef}
        totalListHeightChanged={handleTotalListHeightChanged}
        {...footerProps}
      />
      <ScrollToBottomPill
        visible={!following && canScroll && hasContent}
        onClick={() => {
          setFollowing(true);
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
      // Per-tab Virtuoso instance: isolates measurement cache + follow state and
      // lets each tab restore its own scroll position across switches.
      key={tabId ?? "standalone"}
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
        // Per-tab Virtuoso instance: isolates measurement cache + follow state
        // and lets each tab restore its own scroll position across switches.
        key={tabId ?? "standalone"}
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
