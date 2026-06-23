import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatMessage } from "../../types/a2ui";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  buildTranscriptRows,
  rowKey,
  rowMessageRole,
  type TranscriptRow,
} from "../../utils/transcriptRows";
import type { ResolvedVisibility } from "../../utils/visibilityResolver";
import { ChatMessageRow } from "./message-row";
import {
  CanvasFooter,
  ToolGroupChildRow,
  ToolGroupRow,
  TurnBlockRow,
  type CanvasFooterContext,
} from "./message-groups";
import { queuedDeliveryLabels } from "./message-rendering-utils";
import { useScrollFollowController } from "./useScrollFollowController";
import { recordTranscriptPerfSnapshot } from "./transcript-perf";

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const transcript = useMemo(
    () => buildTranscriptRows(messages, visibility.toolCalls, expandedGroups),
    [messages, visibility.toolCalls, expandedGroups],
  );
  const { groups, rows, heightEstimates } = transcript;
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
    rows,
    tabId,
    scrollToMatch,
    visibility,
    terminalOpen,
    layoutRows,
    virtuosoRef,
  });

  const itemContent = useCallback(
    (index: number, row: TranscriptRow) => {
      // flow-root establishes a BFC so the row's vertical margins (role-change
      // spacing, etc.) are CONTAINED in this wrapper rather than collapsing
      // through it. Virtuoso measures the wrapper, so the margins are counted —
      // bare margins on the row would escape measurement and drift the
      // follow-to-bottom / scrollToIndex offsets in long transcripts.
      const rowClass = `a2ui-msg-row${index === 0 ? " a2ui-msg-row-first" : ""}${
        index === rows.length - 1 ? " a2ui-msg-row-last" : ""
      }`;
      if (row.type === "tool-group-summary") {
        return (
          <div className={rowClass}>
            <ToolGroupRow
              group={row.group}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
              expanded={expandedGroups.has(row.group.id)}
              onToggle={() => toggleGroup(row.group.id)}
            />
          </div>
        );
      }
      if (row.type === "tool-group-child") {
        return (
          <div className={rowClass}>
            <ToolGroupChildRow
              message={row.message}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
            />
          </div>
        );
      }
      if (row.type === "turn-block-summary") {
        return (
          <div className={rowClass}>
            <TurnBlockRow
              group={row.group}
              state={state}
              tabId={tabId}
              onEvent={onEvent}
              rowClassName={rowClassName}
              thinkingVisibility={visibility.thinking}
              expanded={expandedGroups.has(row.group.id)}
              onToggle={() => toggleGroup(row.group.id)}
            />
          </div>
        );
      }
      if (row.type === "turn-block-child") {
        const m = row.message;
        const prevRole = rowMessageRole(rows[index - 1]);
        return (
          <div className={`${rowClass} ae-turn-block-child-row`}>
            <ChatMessageRow
              message={m}
              state={state}
              tabId={tabId}
              className={
                index === scrollController.flashIndex
                  ? `${rowClassName} ae-turn-block-child-message a2ui-chat-message-flash`
                  : `${rowClassName} ae-turn-block-child-message`
              }
              prevRole={prevRole}
              onEvent={onEvent}
              deliveryText={queuedLabels.get(m.id)}
              isLatest={m.id === messages[messages.length - 1]?.id}
              thinkingVisibility={visibility.thinking}
            />
          </div>
        );
      }
      const m = row.message;
      // prevRole drives role-badge suppression on consecutive same-role rows.
      // A preceding tool cluster reads as an agent turn, so it counts as
      // "agent" for that purpose.
      const prevRole = rowMessageRole(rows[index - 1]);
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
            isLatest={m.id === messages[messages.length - 1]?.id}
            thinkingVisibility={visibility.thinking}
          />
        </div>
      );
    },
    [
      state,
      tabId,
      rowClassName,
      scrollController.flashIndex,
      onEvent,
      queuedLabels,
      visibility.thinking,
      expandedGroups,
      toggleGroup,
      messages,
      rows,
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

  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const scroller = scrollController.scrollerElement;
    const metrics = scroller
      ? {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          bottomGap:
            scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        }
      : null;
    recordTranscriptPerfSnapshot({
      tabId,
      activeTabId:
        typeof state.activeTabId === "string" ? state.activeTabId : undefined,
      messageCount: messages.length,
      groupCount: groups.length,
      rowCount: rows.length,
      mountedRowCount: scroller?.querySelectorAll(".a2ui-msg-row").length ?? 0,
      mountedToolCardCount:
        scroller?.querySelectorAll(".ae-tool-card").length ?? 0,
      following: scrollController.following,
      canScroll: scrollController.canScroll,
      scroll: metrics,
    });
  }, [
    groups.length,
    messages.length,
    rows.length,
    scrollController.canScroll,
    scrollController.following,
    scrollController.scrollerElement,
    state.activeTabId,
    tabId,
  ]);

  return (
    <div className="a2ui-msg-list-shell">
      <Virtuoso
        ref={virtuosoRef}
        className={className}
        style={{ flex: 1, minHeight: 0 }}
        data={rows}
        computeItemKey={(index, row) => (row ? rowKey(row) : String(index))}
        itemContent={itemContent}
        heightEstimates={heightEstimates}
        increaseViewportBy={{ top: 600, bottom: 200 }}
        minOverscanItemCount={{ top: 4, bottom: 2 }}
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
