import { useCallback, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatMessage } from "../../types/a2ui";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  groupMessages,
  groupKey,
  type MessageGroup,
} from "../../utils/toolCardGrouping";
import type { ResolvedVisibility } from "../../utils/visibilityResolver";
import { ChatMessageRow } from "./message-row";
import {
  CanvasFooter,
  ToolGroupRow,
  TurnBlockRow,
  type CanvasFooterContext,
} from "./message-groups";
import { queuedDeliveryLabels } from "./message-rendering-utils";
import { useScrollFollowController } from "./useScrollFollowController";

// Restored transcripts often open at the bottom with the first measured row
// being an atypical tool card or markdown block. Letting Virtuoso use that row
// as its initial probe overestimates the unmeasured history above, making the
// scrollbar thumb look too short until the first manual scroll forces more
// measurement. A stable estimate keeps idle restored sessions visually honest;
// real row measurements still replace it as Virtuoso renders.
const DEFAULT_CHAT_ROW_HEIGHT = 120;

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

export interface VirtualMessageFeedProps {
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
 *  SINGLE owner — useScrollFollowController, NOT Virtuoso (its `followOutput`
 *  is disabled). */
export function VirtualMessageFeed({
  messages,
  state,
  tabId,
  onEvent,
  rowClassName = "a2ui-chat-message",
  className,
  scrollToMatch,
  footerContext,
  visibility,
}: VirtualMessageFeedProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
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
  const terminalOpen = Boolean(
    (state.terminal as { open?: boolean } | undefined)?.open,
  );
  const layoutRows =
    (state.layout as { rows?: unknown } | undefined)?.rows ?? null;
  const scrollController = useScrollFollowController({
    messages,
    groups,
    tabId,
    scrollToMatch,
    visibility,
    terminalOpen,
    layoutRows,
    virtuosoRef,
  });

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
              index === scrollController.flashIndex
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
      scrollController.flashIndex,
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

  return (
    <div className="a2ui-msg-list-shell">
      <Virtuoso
        ref={virtuosoRef}
        className={className}
        style={{ flex: 1, minHeight: 0 }}
        data={groups}
        defaultItemHeight={DEFAULT_CHAT_ROW_HEIGHT}
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
        initialTopMostItemIndex={scrollController.initialTopMostItemIndex}
        // followOutput is intentionally OFF: our controller is the single
        // scroller (via totalListHeightChanged), so Virtuoso never auto-scrolls
        // and there is no second source of truth to race. Disabling it also
        // disables Virtuoso's internal size-change re-pin, which proved
        // unreliable (it re-pins only in brief windows and emitted a spurious
        // not-at-bottom after late mount reflow, freezing the pill on).
        followOutput={false}
        rangeChanged={scrollController.handleRangeChanged}
        scrollerRef={scrollController.handleScrollerRef}
        totalListHeightChanged={scrollController.handleTotalListHeightChanged}
        {...footerProps}
      />
      <ScrollToBottomPill
        visible={
          !scrollController.following && scrollController.canScroll && hasContent
        }
        onClick={() => {
          scrollController.setFollowing(true);
          // Scroll to the true bottom of the scroller, which includes the
          // Footer (live subtree / typing indicator) — scrollToIndex(last)
          // would stop at the last message, above a footer-only response.
          scrollController.scrollToBottom();
        }}
      />
    </div>
  );
}
