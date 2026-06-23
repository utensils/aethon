// @vitest-environment jsdom
import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ChatMessage } from "../../types/a2ui";
import { buildTranscriptRows } from "../../utils/transcriptRows";
import type { ResolvedVisibility } from "../../utils/visibilityResolver";
import {
  getScrollFollowCacheAnchorForTests,
  resetScrollFollowCacheForTests,
  useScrollFollowController,
} from "./useScrollFollowController";

const visibility: ResolvedVisibility = { thinking: "show", toolCalls: "show" };

const messages: ChatMessage[] = [
  { id: "m1", role: "user", text: "one" },
  { id: "m2", role: "agent", text: "two" },
  { id: "m3", role: "agent", text: "three" },
];

function setScrollerMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight?: number; scrollHeight?: number },
) {
  Object.defineProperties(el, {
    scrollHeight: {
      value: metrics.scrollHeight ?? el.scrollHeight,
      configurable: true,
    },
    clientHeight: {
      value: metrics.clientHeight ?? el.clientHeight,
      configurable: true,
    },
    scrollTop: {
      value: metrics.scrollTop,
      writable: true,
      configurable: true,
    },
  });
}

function renderController(tabId = "tab-1") {
  const virtuoso = {
    scrollTo: vi.fn(),
    scrollToIndex: vi.fn(),
  } as unknown as VirtuosoHandle;
  const rows = buildTranscriptRows(
    messages,
    visibility.toolCalls,
    new Set(),
  ).rows;
  const hook = renderHook(() => {
    const virtuosoRef = useRef<VirtuosoHandle | null>(virtuoso);
    return useScrollFollowController({
      messages,
      rows,
      tabId,
      visibility,
      terminalOpen: false,
      layoutRows: "1fr 0px",
      virtuosoRef,
    });
  });
  return { ...hook, virtuoso };
}

function renderControllerForMessages({
  testMessages,
  toolCalls = "show",
  scrollToMatch,
  tabId = "tab-1",
}: {
  testMessages: ChatMessage[];
  toolCalls?: ResolvedVisibility["toolCalls"];
  scrollToMatch?: string;
  tabId?: string;
}) {
  const scrollToIndex = vi.fn();
  const virtuoso = {
    scrollTo: vi.fn(),
    scrollToIndex,
  } as unknown as VirtuosoHandle;
  const testVisibility: ResolvedVisibility = {
    thinking: "show",
    toolCalls,
  };
  const rows = buildTranscriptRows(
    testMessages,
    testVisibility.toolCalls,
    new Set(),
  ).rows;
  const hook = renderHook(() => {
    const virtuosoRef = useRef<VirtuosoHandle | null>(virtuoso);
    return useScrollFollowController({
      messages: testMessages,
      rows,
      tabId,
      scrollToMatch,
      visibility: testVisibility,
      terminalOpen: false,
      layoutRows: "1fr 0px",
      virtuosoRef,
    });
  });
  return { ...hook, scrollToIndex, virtuoso, rows };
}

let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>;
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetScrollFollowCacheForTests();
  requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockReturnValue(1);
  cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  requestAnimationFrameSpy.mockRestore();
  cancelAnimationFrameSpy.mockRestore();
});

describe("useScrollFollowController", () => {
  it("ignores un-gestured scroll events so programmatic movement does not disable follow", () => {
    const { result } = renderController();
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 700,
    });

    act(() => result.current.handleScrollerRef(scroller));
    expect(result.current.following).toBe(true);
    expect(result.current.canScroll).toBe(true);

    setScrollerMetrics(scroller, { scrollTop: 0 });
    act(() => fireEvent.scroll(scroller));

    expect(result.current.following).toBe(true);
    expect(getScrollFollowCacheAnchorForTests("tab-1")).toBeUndefined();
  });

  it("caches the top visible message only after a user scroll-away gesture", () => {
    const { result } = renderController();
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 700,
    });

    act(() => result.current.handleScrollerRef(scroller));
    act(() => result.current.handleRangeChanged({ startIndex: 1, endIndex: 2 }));
    setScrollerMetrics(scroller, { scrollTop: 0 });
    act(() => {
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller);
    });

    expect(result.current.following).toBe(false);
    expect(getScrollFollowCacheAnchorForTests("tab-1")).toBe("m2");
  });

  it("restores from a cached anchor and clears it when the user returns to bottom", () => {
    const first = renderController();
    const scroller = document.createElement("div");
    setScrollerMetrics(scroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 700,
    });

    act(() => first.result.current.handleScrollerRef(scroller));
    act(() =>
      first.result.current.handleRangeChanged({ startIndex: 1, endIndex: 2 }),
    );
    setScrollerMetrics(scroller, { scrollTop: 0 });
    act(() => {
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller);
    });
    expect(getScrollFollowCacheAnchorForTests("tab-1")).toBe("m2");
    first.unmount();

    const second = renderController();
    expect(second.result.current.following).toBe(false);
    expect(second.result.current.initialTopMostItemIndex).toEqual({
      index: 1,
      align: "start",
    });

    const restoredScroller = document.createElement("div");
    setScrollerMetrics(restoredScroller, {
      scrollHeight: 1200,
      clientHeight: 500,
      scrollTop: 700,
    });
    act(() => second.result.current.handleScrollerRef(restoredScroller));
    act(() => {
      fireEvent.wheel(restoredScroller);
      fireEvent.scroll(restoredScroller);
    });

    expect(second.result.current.following).toBe(true);
    expect(getScrollFollowCacheAnchorForTests("tab-1")).toBeUndefined();
  });

  it("searches text inside collapsed group-block turns and scrolls to the summary row", async () => {
    const hiddenTurnMessages: ChatMessage[] = [
      { id: "u1", role: "user", text: "run checks" },
      { id: "a1", role: "agent", text: "needle text inside a folded reply" },
      {
        id: "t1",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "c1",
              type: "tool-card",
              props: {
                title: "bash",
                description: "needle hidden tool metadata",
                startedAt: 1,
                endedAt: 2,
              },
            },
          ],
        },
      },
      { id: "u2", role: "user", text: "next turn keeps the previous one completed" },
      { id: "a2", role: "agent", text: "latest visible reply" },
    ];

    const { rows, scrollToIndex } = renderControllerForMessages({
      testMessages: hiddenTurnMessages,
      toolCalls: "group-block",
      scrollToMatch: "hidden tool metadata",
    });

    expect(rows.map((row) => row.type)).toEqual([
      "message",
      "turn-block-summary",
      "message",
      "message",
    ]);
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith({
        index: 1,
        align: "center",
      }),
    );
  });
});
