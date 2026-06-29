// @vitest-environment jsdom
import { forwardRef, useEffect, useImperativeHandle } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistory, ToolCard } from "./chat";
import { ComposerVisibilityPills } from "./composer-visibility-pills";
import {
  createResizeObserverFixture,
  groupedHistoryElement,
  renderChatInput as renderInput,
  renderChatHistory as renderHistory,
  renderGroupedHistory,
  renderMainCanvas,
  resetMockVirtuosoState,
  setScrollerMetrics,
  setScrollTop,
  toolTranscript,
  userScrollToBottom,
  userScrollUp,
  type MockVirtuosoState,
} from "./testFixtures";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

const virtuosoMockState = vi.hoisted(
  (): MockVirtuosoState => ({
    alignToBottom: undefined,
    followOutput: undefined,
    scrollToCalls: [],
    scrollToIndexCalls: [],
    dataLength: undefined,
    heightEstimates: undefined,
    increaseViewportBy: undefined,
    minOverscanItemCount: undefined,
    atBottomStateChange: undefined,
    rangeChanged: undefined,
    totalListHeightChanged: undefined,
  }),
);

const resizeObserver = createResizeObserverFixture();

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(() => Promise.reject(new Error("invoke not mocked"))),
}));

vi.mock("../../components/HighlightedCode", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
}));

// jsdom measures every element as 0px, so the real Virtuoso virtualizes down to
// nothing. Render all rows synchronously here — scroll/measurement behavior is
// verified live in the app, while these tests assert row content + memoization.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(
    (
      {
        data = [],
        itemContent,
        components,
        context,
        className,
        atBottomStateChange,
        rangeChanged,
        scrollerRef,
        totalListHeightChanged,
        alignToBottom,
        followOutput,
        heightEstimates,
        increaseViewportBy,
        minOverscanItemCount,
      }: {
        data?: Array<{ id?: string }>;
        itemContent: (index: number, item: unknown) => React.ReactNode;
        components?: {
          Footer?: (props: { context?: unknown }) => React.ReactNode;
        };
        context?: unknown;
        className?: string;
        atBottomStateChange?: (atBottom: boolean) => void;
        rangeChanged?: (range: {
          startIndex: number;
          endIndex: number;
        }) => void;
        scrollerRef?: (ref: HTMLElement | null) => void;
        totalListHeightChanged?: (height: number) => void;
        alignToBottom?: unknown;
        followOutput?: unknown;
        heightEstimates?: unknown;
        increaseViewportBy?: unknown;
        minOverscanItemCount?: unknown;
      },
      ref,
    ) => {
      const Footer = components?.Footer;
      virtuosoMockState.alignToBottom = alignToBottom;
      virtuosoMockState.followOutput = followOutput;
      virtuosoMockState.dataLength = data.length;
      virtuosoMockState.heightEstimates = heightEstimates;
      virtuosoMockState.increaseViewportBy = increaseViewportBy;
      virtuosoMockState.minOverscanItemCount = minOverscanItemCount;
      virtuosoMockState.atBottomStateChange = atBottomStateChange;
      virtuosoMockState.rangeChanged = rangeChanged;
      virtuosoMockState.totalListHeightChanged = totalListHeightChanged;
      useImperativeHandle(
        ref,
        () => ({
          scrollTo: (options: unknown) => {
            virtuosoMockState.scrollToCalls.push(options);
          },
          scrollToIndex: (options: unknown) => {
            virtuosoMockState.scrollToIndexCalls.push(options);
          },
        }),
        [],
      );
      // jsdom can't measure, so fake a height proportional to row count:
      // ~400px/row vs a 500px viewport means 1 row is not scrollable while 2+
      // rows are. Mount pinned to the bottom (scrollTop at max), like Virtuoso's
      // initialTopMostItemIndex. Follow is driven by real scroll/gesture events
      // (the component owns scrolling); tests fire wheel+scroll to scroll away.
      const scrollHeight = data.length * 400;
      const clientHeight = 500;
      useEffect(() => {
        const el = document.querySelector<HTMLElement>(
          "[data-testid='virtuoso-mock']",
        );
        if (el) {
          Object.defineProperties(el, {
            scrollHeight: { value: scrollHeight, configurable: true },
            clientHeight: { value: clientHeight, configurable: true },
            scrollTop: {
              value: Math.max(0, scrollHeight - clientHeight),
              writable: true,
              configurable: true,
            },
          });
        }
        scrollerRef?.(el);
        totalListHeightChanged?.(scrollHeight);
        return () => scrollerRef?.(null);
      }, [scrollHeight, scrollerRef, totalListHeightChanged]);
      return (
        <div className={className} data-testid="virtuoso-mock">
          {data.map((item, index) => (
            <div key={item.id ?? index}>{itemContent(index, item)}</div>
          ))}
          {Footer ? <Footer context={context} /> : null}
        </div>
      );
    },
  ),
}));
import { ExtensionRegistry } from "../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../ExtensionRegistryProvider";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import { invoke } from "@tauri-apps/api/core";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", resizeObserver.Mock);
  invokeMock.mockImplementation(() =>
    Promise.reject(new Error("invoke not mocked")),
  );
  resizeObserver.callbacks.length = 0;
  openUrl.mockResolvedValue(undefined);
  resetMockVirtuosoState(virtuosoMockState);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

function renderComposerPills(
  onEvent = vi.fn(),
  state: Record<string, unknown> = {},
  tabId = "tab-1",
) {
  const result = render(
    <ComposerVisibilityPills
      component={{
        id: "composer-visibility-pills",
        type: "composer-visibility-pills",
        props: {},
      }}
      state={state}
      tabId={tabId}
      onEvent={onEvent}
    />,
  );
  return { onEvent, ...result };
}

function triggerResizeObservers() {
  resizeObserver.trigger();
}

function renderToolCard(props: Record<string, unknown>) {
  return render(
    <ToolCard
      component={{
        id: "tool-1",
        type: "tool-card",
        props: { title: "bash", description: "sleep 60", ...props },
      }}
      state={{}}
      onEvent={vi.fn()}
      renderChildren={() => <div>output</div>}
    />,
  );
}

describe("ToolCard", () => {
  it("shows a cancelled terminal state and freezes elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const { container } = renderToolCard({
      startedAt: 1_000,
      endedAt: 3_000,
      status: "cancelled",
    });

    expect(screen.getByText("Cancelled in 2.0s")).toBeTruthy();
    expect(screen.queryByText(/long-running/)).toBeNull();
    // State is conveyed by the card's border + duration label, not a glyph.
    expect(
      container.querySelector('.ae-tool-card[data-cancelled="true"]'),
    ).toBeTruthy();

    vi.setSystemTime(30_000);
    vi.advanceTimersByTime(1_000);

    expect(screen.getByText("Cancelled in 2.0s")).toBeTruthy();
  });

  it("renders completed and failed terminal states with stable durations", () => {
    const { rerender, container } = renderToolCard({
      startedAt: 1_000,
      endedAt: 2_500,
    });
    expect(screen.getByText("Completed in 1.5s")).toBeTruthy();

    rerender(
      <ToolCard
        component={{
          id: "tool-1",
          type: "tool-card",
          props: {
            title: "bash",
            description: "sleep 60",
            startedAt: 1_000,
            endedAt: 2_500,
            isError: true,
          },
        }}
        state={{}}
        onEvent={vi.fn()}
        renderChildren={() => <div>output</div>}
      />,
    );
    expect(screen.getByText("Failed in 1.5s")).toBeTruthy();
    expect(
      container.querySelector('.ae-tool-card[data-error="true"]'),
    ).toBeTruthy();
  });
});

describe("ChatInput", () => {
  it("submits bare Enter as a normal queued-capable message", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "queue this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "queue this",
      mode: "normal",
    });
  });

  it("submits command-enter as a steering message", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "steer this" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "steer this",
      mode: "steer",
    });
  });

  it("submits ctrl-enter as a steering message for non-mac keyboards", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "steer with ctrl" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "steer with ctrl",
      mode: "steer",
    });
  });

  it("submits empty command-enter when queued messages can be steered", () => {
    const { input, onEvent } = renderInput(
      vi.fn(),
      { disabled: { $ref: "/waiting" }, queueCount: { $ref: "/queueCount" } },
      {
        waiting: true,
        queueCount: 1,
        queuedMessages: [{ id: "q1", content: "latest queued" }],
      },
    );

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "",
      mode: "steer",
    });
  });

  it("does not submit empty command-enter without queued messages", () => {
    const { input, onEvent } = renderInput(
      vi.fn(),
      { disabled: { $ref: "/waiting" }, queueCount: { $ref: "/queueCount" } },
      { waiting: true, queueCount: 0, queuedMessages: [] },
    );

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });

  it("does not submit shift-enter", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "new line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });

  it("keeps the plan-mode toggle out of the message field", () => {
    renderInput(
      vi.fn(),
      { planMode: { $ref: "/planMode" } },
      { planMode: true },
    );

    expect(screen.queryByRole("button", { name: /plan mode/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /implementation mode/i }),
    ).toBeNull();
  });

  it("renders a compact plan-mode pill that toggles the mode", () => {
    const onEvent = vi.fn();
    renderComposerPills(onEvent, {
      tabs: [{ id: "tab-1", kind: "agent", planMode: true }],
      transcriptVisibility: { thinking: "show", toolCalls: "show" },
    });

    const pill = screen.getByRole("button", { name: /Plan mode: on/ });
    expect(pill.textContent).toContain("Plan mode");
    expect(pill.textContent).toContain("on");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);

    expect(onEvent).toHaveBeenLastCalledWith("toggle-plan");
  });

  it("reads plan-mode off state from the active tab", () => {
    renderComposerPills(vi.fn(), {
      planMode: true,
      tabs: [{ id: "tab-1", kind: "agent", planMode: false }],
      transcriptVisibility: { thinking: "show", toolCalls: "show" },
    });

    const pill = screen.getByRole("button", { name: /Plan mode: off/ });
    expect(pill.textContent).toContain("off");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  it("cleans up composer resize state if unmounted mid-drag", () => {
    const { unmount } = renderInput();

    fireEvent.mouseDown(screen.getByLabelText("Resize composer"), {
      clientY: 120,
    });
    expect(document.body.classList.contains("ae-resizing-composer")).toBe(true);

    unmount();

    expect(document.body.classList.contains("ae-resizing-composer")).toBe(
      false,
    );
  });

  it("shows the running-turn shortcut hint only when busy", () => {
    renderInput(vi.fn(), { disabled: { $ref: "/waiting" } }, { waiting: true });

    expect(screen.getByText("Enter queues")).toBeTruthy();
    expect(screen.getByText("Cmd/Ctrl+Enter steers")).toBeTruthy();

    cleanup();
    renderInput(
      vi.fn(),
      { disabled: { $ref: "/waiting" } },
      { waiting: false },
    );
    expect(screen.queryByText("Enter queues")).toBeNull();
  });

  it("makes stop queue-clearing behavior visible when follow-ups are queued", () => {
    renderInput(
      vi.fn(),
      { disabled: { $ref: "/waiting" }, queueCount: { $ref: "/queueCount" } },
      { waiting: true, queueCount: 2 },
    );

    expect(
      screen
        .getByRole("button", { name: "Stop + clear" })
        .getAttribute("title"),
    ).toBe("Stop the current prompt and clear 2 messages queued");
    expect(screen.getByText("+2").getAttribute("title")).toBe(
      "2 messages queued behind the current prompt",
    );
    expect(
      screen.getByText("Cmd/Ctrl+Enter steers latest queued"),
    ).toBeTruthy();
  });

  it("renders draft image attachments and submits them with the message", () => {
    const attachment = {
      id: "img-1",
      kind: "image" as const,
      path: "/tmp/one.png",
      name: "one.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const { input, onEvent } = renderInput(
      vi.fn(),
      {},
      { draftAttachments: [attachment] },
    );

    expect(screen.getByText("one.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open one.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "",
      mode: "normal",
      attachments: [attachment],
    });
  });

  it("renders queued and steered delivery badges on user messages", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "after this", delivery: "queued" },
        { id: "2", role: "user", text: "look now", delivery: "steered" },
      ],
    });

    expect(screen.getByText("queued")).toBeTruthy();
    expect(screen.getByText("steered")).toBeTruthy();
  });

  it("numbers queued delivery badges when multiple follow-ups are waiting", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "running", delivery: "sent" },
        { id: "2", role: "user", text: "first queued", delivery: "queued" },
        { id: "3", role: "user", text: "second queued", delivery: "queued" },
      ],
    });

    expect(screen.getByText("queued #1")).toBeTruthy();
    expect(screen.getByText("queued #2")).toBeTruthy();
  });

  it("renders retry actions for failed user messages", () => {
    const { onEvent } = renderHistory({
      messages: [
        { id: "1", role: "user", text: "again please", delivery: "failed" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onEvent).toHaveBeenCalledWith("retry", {
      messageId: "1",
      value: "again please",
    });
  });

  it("handles nested tool-file events without forwarding them to the agent", async () => {
    invokeMock.mockResolvedValue(undefined);
    invokeMock.mockClear();
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-tool-card",
      components: { "tool-card": ToolCard },
    });
    const onEvent = vi.fn();
    render(
      <ExtensionRegistryProvider registry={registry}>
        <ChatHistory
          component={{
            id: "chat-history",
            type: "chat-history",
            props: { messages: { $ref: "/messages" } },
          }}
          state={{
            messages: [
              {
                id: "1",
                role: "agent",
                a2ui: {
                  components: [
                    {
                      id: "tool-edit-preview",
                      type: "tool-card",
                      props: {
                        title: "edit",
                        endedAt: 2,
                        fileChange: {
                          kind: "edited",
                          path: "src/App.tsx",
                          rootPath: "/repo/aethon",
                        },
                      },
                    },
                  ],
                },
              },
            ],
          }}
          onEvent={onEvent}
        />
      </ExtensionRegistryProvider>,
    );

    fireEvent.click(screen.getByTitle("Open src/App.tsx"));

    expect(onEvent).toHaveBeenCalledWith(
      "tool-file-open",
      { filePath: "src/App.tsx", rootPath: "/repo/aethon" },
      "tool-edit-preview",
    );
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "dispatch_a2ui_event",
      expect.anything(),
    );
  });

  it("keeps the latest pill hidden when the feed is not scrollable", () => {
    renderHistory({
      messages: [{ id: "1", role: "agent", text: "short answer" }],
    });

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("starts pinned to latest without Virtuoso's zoom-sensitive auto-follow props", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
    // The controller owns scrolling; Virtuoso's own follow/bottom-align paths
    // are off so they cannot mix root CSS zoom with scroll geometry and strand
    // the terminal-close view above latest.
    expect(virtuosoMockState.followOutput).toBe(false);
    expect(virtuosoMockState.alignToBottom).toBeUndefined();
  });

  it("renders a textual live activity indicator before visible agent output", () => {
    renderMainCanvas({
      waiting: true,
      messages: [{ id: "1", role: "user", text: "start" }],
    });

    const indicator = screen.getByRole("status", {
      name: "Waiting for model response. No tool calls are currently running",
    });
    expect(screen.getByText("Waiting for model response")).toBeTruthy();
    expect(
      screen.getByText("No tool calls are currently running"),
    ).toBeTruthy();
    expect(indicator.querySelectorAll(".ae-typing-dot")).toHaveLength(0);
    expect(indicator.closest(".a2ui-msg-row-footer")).toBeTruthy();
    expect(indicator.closest(".ae-conversation-turn")).toBeTruthy();
    expect(indicator.closest(".a2ui-canvas-message.agent")).toBeTruthy();
  });

  it("hides the footer activity while agent prose is streaming", () => {
    renderMainCanvas({
      waiting: true,
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    expect(screen.getByText("streaming update")).toBeTruthy();
    expect(screen.queryByText("Waiting for model response")).toBeNull();
    expect(screen.queryByText("Writing response")).toBeNull();
    expect(screen.queryByText("Streaming the answer")).toBeNull();
  });

  it("does not infer footer activity from planning prose", () => {
    renderMainCanvas({
      waiting: true,
      messages: [
        {
          id: "1",
          role: "user",
          text: "Explore this directory and summarize it for me",
        },
        {
          id: "2",
          role: "agent",
          text: "I’m going to sample the durable config versus cache/log state.",
        },
      ],
    });

    expect(screen.getByText(/sample the durable config/)).toBeTruthy();
    expect(screen.queryByText("Reading directory contents")).toBeNull();
    expect(screen.queryByText("Inspecting files and folders")).toBeNull();
    expect(screen.queryByText("Writing response")).toBeNull();
  });

  it("clears footer activity when final answer prose is streaming", () => {
    renderMainCanvas({
      waiting: true,
      messages: [
        {
          id: "1",
          role: "user",
          text: "Explore this directory and summarize it for me",
        },
        {
          id: "2",
          role: "agent",
          text:
            "/Users/jamesbrink/.aethon is your Aethon user data/config directory.\n\n" +
            "Key findings:\n\n" +
            "- Purpose: Stores runtime state, sessions, project registry, and extensions.\n" +
            "- Not a git repo: No project source history here.",
        },
      ],
    });

    expect(screen.getByText(/Key findings/)).toBeTruthy();
    expect(screen.queryByText("Reading directory contents")).toBeNull();
    expect(screen.queryByText("Writing response")).toBeNull();
  });

  it("does not show the footer activity indicator when running tool activity is visible", () => {
    renderMainCanvas({
      waiting: true,
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "I’ll search first." },
        {
          id: "3",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-bash",
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "rg message-row",
                  startedAt: 1000,
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    expect(screen.getByText("Searching files")).toBeTruthy();
    expect(screen.queryByText("Waiting for model response")).toBeNull();
  });

  it("labels hidden running directory tools as directory reading", () => {
    renderMainCanvas({
      waiting: true,
      messages: [
        { id: "1", role: "user", text: "summarize this directory" },
        { id: "2", role: "agent", text: "I’ll inspect the top-level shape." },
        {
          id: "3",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-bash",
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "find . -maxdepth 2 -type f | head -200",
                  startedAt: 1000,
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    expect(screen.getByText("Reading directory contents")).toBeTruthy();
    expect(screen.getByText("Inspecting files and folders")).toBeTruthy();
    expect(screen.queryByText("Writing response")).toBeNull();
  });

  it("shows the pill and stops following when the user scrolls up", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));

    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("re-engages follow and hides the pill when the user scrolls back to bottom", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();

    act(() => userScrollToBottom(scroller));
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("ignores un-gestured scroll events (our own re-pins) — follow stays on", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    // A scroll event WITHOUT a preceding user gesture (as a programmatic re-pin
    // produces) must not disengage follow.
    setScrollTop(scroller, 0);
    act(() => fireEvent.scroll(scroller));

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("re-pins to the bottom on content growth while following", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    setScrollerMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTop: 500,
    });
    setScrollTop(scroller, 0);
    const before = virtuosoMockState.scrollToCalls.length;
    // Content grew (e.g. a streamed token) → totalListHeightChanged fires.
    act(() => virtuosoMockState.totalListHeightChanged?.(2000));

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("coalesces repeated follow pin settle loops", () => {
    vi.useFakeTimers();
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    setScrollerMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTop: 500,
    });
    setScrollTop(scroller, 0);
    act(() => virtuosoMockState.totalListHeightChanged?.(2000));
    const afterFirstPin = vi.getTimerCount();

    setScrollTop(scroller, 0);
    act(() => virtuosoMockState.totalListHeightChanged?.(2200));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(afterFirstPin);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("re-pins to the bottom on viewport resize while following", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    setScrollerMetrics(scroller, {
      scrollHeight: 1000,
      clientHeight: 500,
      scrollTop: 500,
    });
    setScrollTop(scroller, 100);
    const before = virtuosoMockState.scrollToCalls.length;

    act(() => triggerResizeObservers());

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("stays pinned through terminal close and reopen viewport changes", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    setScrollerMetrics(scroller, {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
    });

    // Terminal closes: chat viewport expands.
    setScrollerMetrics(scroller, { clientHeight: 900, scrollTop: 1100 });
    act(() => triggerResizeObservers());
    expect(
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    ).toBe(0);

    const afterClose = virtuosoMockState.scrollToCalls.length;
    // Terminal reopens: chat viewport shrinks again.
    setScrollerMetrics(scroller, { clientHeight: 500, scrollTop: 1500 });
    act(() => triggerResizeObservers());
    expect(virtuosoMockState.scrollToCalls.length).toBe(afterClose);
    expect(
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    ).toBe(0);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("keeps pinning after terminal close while Virtuoso settles delayed height", () => {
    vi.useFakeTimers();
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "streaming update" },
    ];
    const view = (terminalOpen: boolean) => (
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages,
          terminal: { open: terminalOpen },
          layout: {
            rows: terminalOpen
              ? "38px 38px minmax(0,1fr) 366px auto auto"
              : "38px 38px minmax(0,1fr) 0px auto auto",
          },
        }}
        onEvent={vi.fn()}
      />
    );
    const { rerender } = render(view(true));
    const scroller = screen.getByTestId("virtuoso-mock");
    setScrollerMetrics(scroller, {
      scrollHeight: 3000,
      clientHeight: 500,
      scrollTop: 2500,
    });

    // Terminal closes and the viewport expands immediately, but the real
    // Virtuoso/WebKit stack can publish its final scrollHeight later.
    rerender(view(false));
    setScrollerMetrics(scroller, { clientHeight: 900, scrollTop: 2100 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    setScrollerMetrics(scroller, {
      scrollHeight: 3604,
      scrollTop: scroller.scrollTop,
    });
    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("stays pinned on repeated terminal row toggles even without ResizeObserver", () => {
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "streaming update" },
    ];
    const view = (terminalOpen: boolean) => (
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages,
          terminal: { open: terminalOpen },
          layout: {
            rows: terminalOpen
              ? "38px 38px minmax(0,1fr) 366px auto auto"
              : "38px 38px minmax(0,1fr) 0px auto auto",
          },
        }}
        onEvent={vi.fn()}
      />
    );
    const { rerender } = render(view(true));
    const scroller = screen.getByTestId("virtuoso-mock");

    setScrollerMetrics(scroller, {
      scrollHeight: 2200,
      clientHeight: 500,
      scrollTop: 1700,
    });
    const before = virtuosoMockState.scrollToCalls.length;

    rerender(view(false));
    setScrollerMetrics(scroller, { clientHeight: 900, scrollTop: 700 });
    rerender(view(true));
    setScrollerMetrics(scroller, { clientHeight: 500, scrollTop: 1700 });
    rerender(view(false));

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThanOrEqual(
      before,
    );
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("does NOT re-pin on viewport resize after the user scrolled away", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    const before = virtuosoMockState.scrollToCalls.length;

    act(() => triggerResizeObservers());

    expect(virtuosoMockState.scrollToCalls.length).toBe(before);
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("does NOT re-pin on content growth after the user scrolled away", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    const before = virtuosoMockState.scrollToCalls.length;

    act(() => virtuosoMockState.totalListHeightChanged?.(4000));

    // Following is off → streaming growth must not yank the reader to the bottom.
    expect(virtuosoMockState.scrollToCalls.length).toBe(before);
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("resumes following when a new user message is appended after scroll-away", () => {
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "previous answer" },
    ];
    const { onEvent, rerender } = renderHistory({ messages });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
    const before = virtuosoMockState.scrollToCalls.length;

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages: [
            ...messages,
            { id: "3", role: "user", text: "follow this new prompt" },
          ],
        }}
        onEvent={onEvent}
      />,
    );

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("resumes following when a user message and first agent row append together", () => {
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "previous answer" },
    ];
    const { onEvent, rerender } = renderHistory({ messages });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
    const before = virtuosoMockState.scrollToCalls.length;

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages: [
            ...messages,
            { id: "3", role: "user", text: "follow this new prompt" },
            { id: "4", role: "agent", text: "starting work" },
          ],
        }}
        onEvent={onEvent}
      />,
    );

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("keeps pinning after a user send while Virtuoso settles delayed measurements", () => {
    vi.useFakeTimers();
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "previous answer" },
    ];
    const { onEvent, rerender } = renderHistory({ messages });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages: [
            ...messages,
            { id: "3", role: "user", text: "follow this new prompt" },
          ],
        }}
        onEvent={onEvent}
      />,
    );

    setScrollerMetrics(scroller, {
      scrollHeight: scroller.scrollHeight + 600,
      scrollTop: scroller.scrollTop,
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("does not treat non-scrolling keydowns as a scroll-away", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    // Enter is not a scroll-intent key; a following scroll event must be ignored.
    fireEvent.keyDown(scroller, { key: "Enter" });
    setScrollTop(scroller, 0);
    act(() => fireEvent.scroll(scroller));

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("treats a PageUp keydown as a scroll-away gesture", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    fireEvent.keyDown(scroller, { key: "PageUp" });
    setScrollerMetrics(scroller, {
      scrollHeight: scroller.clientHeight + 400,
      scrollTop: scroller.scrollTop,
    });
    setScrollTop(scroller, 0);
    act(() => fireEvent.scroll(scroller));

    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("pill click scrolls to the true bottom and re-engages follow", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    fireEvent.click(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    );

    // scrollTo({ top: MAX }) targets the true bottom (below any footer).
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("keeps follow off across streaming once the user has scrolled away", () => {
    const messages = [
      { id: "1", role: "user", text: "start" },
      { id: "2", role: "agent", text: "streaming update", thinking: "plan" },
    ];
    const { onEvent, rerender } = renderHistory({ waiting: true, messages });

    const scroller = screen.getByTestId("virtuoso-mock");
    act(() => userScrollUp(scroller));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
    const before = virtuosoMockState.scrollToCalls.length;

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          waiting: true,
          messages: [
            messages[0],
            { ...messages[1], thinking: "plan\nmore streamed thinking" },
          ],
        }}
        onEvent={onEvent}
      />,
    );
    act(() => virtuosoMockState.totalListHeightChanged?.(3000));

    // Streaming more content must not silently re-enable follow or yank down.
    expect(virtuosoMockState.scrollToCalls.length).toBe(before);
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("renders a streaming fenced block as a code frame (follow stays pinned)", () => {
    renderHistory({
      waiting: true,
      messages: [
        { id: "1", role: "user", text: "show code" },
        {
          id: "2",
          role: "agent",
          text: ["```text", "hello", "```"].join("\n"),
        },
      ],
    });

    expect(document.querySelector(".a2ui-code-frame")).toBeTruthy();
    expect(screen.queryByText("```text")).toBeNull();
    // Virtuoso's own follow is disabled; the controller re-pins via height change.
    expect(virtuosoMockState.followOutput).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("rerenders the latest fenced message when streaming finishes", () => {
    const messages = [
      { id: "1", role: "user", text: "show code" },
      {
        id: "2",
        role: "agent",
        text: ["```text", "hello", "```"].join("\n"),
      },
    ];
    const { onEvent, rerender } = renderHistory({
      waiting: true,
      messages,
    });

    expect(document.querySelector(".a2ui-code-frame")).toBeTruthy();

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{ waiting: false, messages }}
        onEvent={onEvent}
      />,
    );

    expect(document.querySelector(".a2ui-code-frame")).toBeNull();
  });

  it("renders normal streaming prose without a code frame (follow stays pinned)", () => {
    renderHistory({
      waiting: true,
      messages: [
        { id: "1", role: "user", text: "go" },
        { id: "2", role: "agent", text: "ordinary streaming answer" },
      ],
    });

    expect(document.querySelector(".a2ui-code-frame")).toBeNull();
    expect(virtuosoMockState.followOutput).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("renders user image attachments and opens them in a lightbox", () => {
    renderHistory({
      messages: [
        {
          id: "1",
          role: "user",
          text: "see this",
          attachments: [
            {
              id: "img-1",
              kind: "image",
              path: "/tmp/one.png",
              name: "one.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open one.png" }));
    expect(
      screen.getByRole("dialog", { name: "Image preview: one.png" }),
    ).toBeTruthy();
    expect(screen.getAllByText("one.png").length).toBeGreaterThanOrEqual(2);
  });

  it("renders bare HTTP URLs as links in user, agent, and system bubbles", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "see https://example.com/user" },
        { id: "2", role: "agent", text: "see https://example.com/agent" },
        { id: "3", role: "system", text: "see https://example.com/system" },
      ],
    });

    expect(
      screen
        .getByRole("link", { name: "https://example.com/user" })
        .getAttribute("href"),
    ).toBe("https://example.com/user");
    expect(
      screen
        .getByRole("link", { name: "https://example.com/agent" })
        .getAttribute("href"),
    ).toBe("https://example.com/agent");
    expect(
      screen
        .getByRole("link", { name: "https://example.com/system" })
        .getAttribute("href"),
    ).toBe("https://example.com/system");
  });

  it("opens bare and Markdown links through the external opener", () => {
    renderHistory({
      messages: [
        {
          id: "1",
          role: "agent",
          text: [
            "Bare https://example.com/bare.",
            "[Issue](https://github.com/utensils/aethon/issues/94)",
          ].join(" "),
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("link", { name: "https://example.com/bare" }),
    );
    fireEvent.click(screen.getByRole("link", { name: "Issue" }));

    expect(openUrl).toHaveBeenCalledWith("https://example.com/bare");
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/utensils/aethon/issues/94",
    );
  });

  it("ignores synchronous opener failures from link clicks", () => {
    openUrl.mockImplementationOnce(() => {
      throw new Error("opener failed");
    });
    renderHistory({
      messages: [{ id: "1", role: "agent", text: "https://example.com/fail" }],
    });

    expect(() =>
      fireEvent.click(
        screen.getByRole("link", { name: "https://example.com/fail" }),
      ),
    ).not.toThrow();
  });

  it("does not linkify URLs in inline code or fenced code blocks", () => {
    renderHistory({
      messages: [
        {
          id: "1",
          role: "agent",
          text: [
            "`https://example.com/code`",
            "",
            "```text",
            "https://example.com/block",
            "```",
            "",
            "https://example.com/plain",
          ].join("\n"),
        },
      ],
    });

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe("https://example.com/plain");
  });

  it("does not render unsupported Markdown link schemes as anchors", () => {
    renderHistory({
      messages: [
        {
          id: "1",
          role: "agent",
          text: [
            "[bad](javascript:alert(1))",
            "[mail](mailto:a@example.com)",
            "[ok](https://example.com/ok)",
          ].join(" "),
        },
      ],
    });

    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "mail" })).toBeNull();
    expect(screen.getByRole("link", { name: "ok" }).getAttribute("href")).toBe(
      "https://example.com/ok",
    );
  });

  it("linkifies text split around thinking blocks", () => {
    renderHistory({
      transcriptVisibility: { thinking: "show", toolCalls: "show" },
      messages: [
        {
          id: "1",
          role: "agent",
          text: [
            "before https://example.com/before",
            "<thinking>check https://example.com/thinking</thinking>",
            "after https://example.com/after",
          ].join(" "),
        },
      ],
    });

    expect(
      screen.getByRole("link", { name: "https://example.com/before" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://example.com/thinking" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://example.com/after" }),
    ).toBeTruthy();
  });

  it("hides thinking blocks by default for a clean transcript", () => {
    renderHistory({
      messages: [
        {
          id: "1",
          role: "agent",
          text: [
            "before https://example.com/before",
            "<thinking>check https://example.com/thinking</thinking>",
            "after https://example.com/after",
          ].join(" "),
        },
      ],
    });

    expect(
      screen.getByRole("link", { name: "https://example.com/before" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "https://example.com/thinking" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "https://example.com/after" }),
    ).toBeTruthy();
  });

  it("treats legacy collapsed thinking as hidden and show as a static block", () => {
    const message = {
      id: "1",
      role: "agent",
      text: "before <thinking>check the plan</thinking> after",
    };
    const { onEvent, rerender } = renderHistory({
      messages: [message],
      waiting: false,
      transcriptVisibility: { thinking: "collapse", toolCalls: "show" },
    });

    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.queryByText("check the plan")).toBeNull();

    rerender(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages: [message],
          waiting: true,
          transcriptVisibility: { thinking: "show", toolCalls: "show" },
        }}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByText("Thinking").closest("details")).toBeNull();
    expect(screen.getByText("check the plan")).toBeTruthy();
  });
});

describe("ChatInput @ completion", () => {
  const WALK = ["/proj/src/App.tsx", "/proj/src/main.tsx", "/proj/README.md"];
  const KIMI = {
    scope: "user",
    name: "kimi",
    filePath: "/agents/kimi.md",
    content:
      "---\ndescription: Reviews code with Moonshot Kimi.\nmodel: openrouter/moonshotai/kimi-k2.7-code\n---\nYou review code.\n",
  };

  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(WALK)
        : cmd === "subagents_list"
          ? Promise.resolve([])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
  });

  afterEach(() => {
    // Restore the module-level default so unrelated tests keep seeing
    // the "invoke not mocked" rejection.
    invokeMock.mockImplementation(() =>
      Promise.reject(new Error("invoke not mocked")),
    );
  });

  function renderWithProject(onEvent = vi.fn()) {
    return renderInput(onEvent, {}, { project: { path: "/proj" } });
  }

  it("offers file suggestions while typing an @token", async () => {
    const { input } = renderWithProject();

    fireEvent.change(input, { target: { value: "@app" } });

    expect(await screen.findByText("App.tsx")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("fs_walk_project", {
      root: "/proj",
    });
  });

  it("offers leading subagent suggestions and inserts one on Tab", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(WALK)
        : cmd === "subagents_list"
          ? Promise.resolve([KIMI])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    const { input } = renderWithProject();

    fireEvent.change(input, { target: { value: "@ki" } });

    expect(await screen.findByText("@kimi")).toBeTruthy();
    expect(screen.getByText("Reviews code with Moonshot Kimi.")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("subagents_list", {
      projectRoot: "/proj",
    });

    fireEvent.keyDown(input, { key: "Tab" });
    expect((input as HTMLTextAreaElement).value).toBe("@kimi ");
  });

  it("offers subagents for mid-draft @tokens with a typed name fragment", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(WALK)
        : cmd === "subagents_list"
          ? Promise.resolve([KIMI])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    const { input } = renderWithProject();

    fireEvent.change(input, { target: { value: "hello @ki" } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("subagents_list", {
        projectRoot: "/proj",
      }),
    );
    expect(await screen.findByText("@kimi")).toBeTruthy();
  });

  it("completes an exact leading subagent on Enter before submitting", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(WALK)
        : cmd === "subagents_list"
          ? Promise.resolve([KIMI])
          : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    const { input, onEvent } = renderWithProject();

    fireEvent.change(input, { target: { value: "@kimi" } });
    await screen.findByText("@kimi");
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("@kimi ");
    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });

  it("inserts the highlighted file on Tab", async () => {
    const { input } = renderWithProject();

    fireEvent.change(input, { target: { value: "@app" } });
    await screen.findByText("App.tsx");
    fireEvent.keyDown(input, { key: "Tab" });

    expect((input as HTMLTextAreaElement).value).toBe("@src/App.tsx ");
  });

  it("completes on Enter instead of submitting while the picker is open", async () => {
    const { input, onEvent } = renderWithProject();

    fireEvent.change(input, { target: { value: "@app" } });
    await screen.findByText("App.tsx");
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("@src/App.tsx ");
    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });

  it("dismisses on Escape and lets Enter submit the raw draft", async () => {
    const { input, onEvent } = renderWithProject();

    fireEvent.change(input, { target: { value: "@app" } });
    await screen.findByText("App.tsx");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByText("App.tsx")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "@app",
      mode: "normal",
    });
  });

  it("submits on Enter when the typed token is already an exact path", async () => {
    const { input, onEvent } = renderWithProject();

    fireEvent.change(input, { target: { value: "@src/App.tsx" } });
    await screen.findByText("App.tsx");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenLastCalledWith("submit", {
      value: "@src/App.tsx",
      mode: "normal",
    });
  });

  it("never triggers inside an email address", () => {
    const { input } = renderWithProject();

    fireEvent.change(input, { target: { value: "mail me@example" } });

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ChatHistory render isolation", () => {
  // Perf regression guard (#159): streaming a new message rewrites the
  // top-level `messages`/`tabs` keys on every token, producing a fresh root
  // state object. Rows still receive the full root state, but the row memo
  // compares it with `shallowEqualExcept`, ignoring those volatile keys — so an
  // already-rendered A2UI row bails and does NOT reconcile on that churn. A
  // plain `prev.state === next.state` check (the old behavior) re-renders every
  // A2UI row per token, which is the scroll/stream lag this test pins down.
  it("does not re-render an existing A2UI row when another message is appended", () => {
    let spyRenders = 0;
    function SpyCard({ component }: BuiltinComponentProps) {
      spyRenders += 1;
      return <div data-testid="spy-card">{component.id}</div>;
    }
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-spy",
      components: { "spy-card": SpyCard },
    });

    // Stable reference across both renders — mirrors how the bridge keeps an
    // already-delivered tool-card message object identity-stable.
    const a2uiMessage = {
      id: "tool-1",
      role: "agent" as const,
      a2ui: { components: [{ id: "spy-1", type: "spy-card" }] },
    };

    // Stable onEvent — the row memo also keys on its identity, so a fresh
    // function per render would mask the slice-stability we're testing.
    const onEvent = vi.fn();
    const renderWith = (state: Record<string, unknown>) => (
      <ExtensionRegistryProvider registry={registry}>
        <ChatHistory
          component={{
            id: "chat-history",
            type: "chat-history",
            props: { messages: { $ref: "/messages" } },
          }}
          state={state}
          tabId="tab-1"
          onEvent={onEvent}
        />
      </ExtensionRegistryProvider>
    );

    const { rerender } = render(
      renderWith({ messages: [a2uiMessage], theme: "dark" }),
    );
    expect(screen.getByTestId("spy-card")).toBeTruthy();
    // A2UIRenderer's mount re-sync effect can render the card more than once;
    // take whatever the settled count is as the baseline.
    const baseline = spyRenders;

    // New top-level state object with a fresh `messages` array (as setState
    // produces per token), but the A2UI message and every retained key are
    // unchanged. The row must not reconcile.
    rerender(
      renderWith({
        messages: [a2uiMessage, { id: "t2", role: "agent", text: "hi" }],
        theme: "dark",
      }),
    );

    expect(spyRenders).toBe(baseline);
  });
});

describe("ChatHistory turn activity feed (mocked Virtuoso renders rows)", () => {
  // Two completed tool-using turns plus a final live-ish turn; the bridge
  // emits each tool call as its own role:"agent" message carrying a tool-card.
  const toolMessages = toolTranscript();

  it("group-run summarizes completed tool work without leaking tool names", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-run" },
    });
    expect(screen.getByText("done")).toBeTruthy();
    const summary = screen.getByRole("button", { name: /2 tool calls/ });
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain("Worked for 1s · 2 tool calls");
    expect(screen.queryByText(/read · bash/)).toBeNull();
  });

  it("passes per-row height estimates and overscan hints to Virtuoso", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-block" },
    });
    expect(virtuosoMockState.dataLength).toBeTypeOf("number");
    expect(virtuosoMockState.heightEstimates).toHaveLength(
      virtuosoMockState.dataLength!,
    );
    expect(virtuosoMockState.increaseViewportBy).toEqual({
      top: 600,
      bottom: 200,
    });
    expect(virtuosoMockState.minOverscanItemCount).toEqual({
      top: 4,
      bottom: 2,
    });
  });

  it("clears stale entering-row markers when animations do not fire", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { rerender } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "first" },
        { id: "a1", role: "agent", text: "done" },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    rerender(
      groupedHistoryElement({
        messages: [
          { id: "u1", role: "user", text: "first" },
          { id: "a1", role: "agent", text: "done" },
          { id: "u2", role: "user", text: "second" },
        ],
        transcriptVisibility: { toolCalls: "hide" },
      }),
    );

    expect(document.querySelector(".a2ui-msg-row-enter")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1200));
    expect(document.querySelector(".a2ui-msg-row-enter")).toBeNull();
  });

  it("labels assistant turns with the message model when available", () => {
    renderGroupedHistory({
      model: "openai-codex/gpt-5.5",
      sidebar: {
        models: [{ id: "openai-codex/gpt-5.5", label: "GPT-5.5" }],
      },
      messages: [
        { id: "u1", role: "user", text: "hi" },
        {
          id: "a1",
          role: "agent",
          text: "done",
          model: "openai-codex/gpt-5.5",
        },
        { id: "u2", role: "user", text: "again" },
        {
          id: "a2",
          role: "agent",
          text: "ok",
          model: "ollama/qwen3.6-128k:latest",
        },
      ],
      transcriptVisibility: { toolCalls: "group-block" },
    });

    expect(screen.getByText("GPT-5.5")).toBeTruthy();
    expect(screen.getByText("qwen3.6-128k:latest")).toBeTruthy();
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("labels unlabeled assistant turns with the current session model", () => {
    renderGroupedHistory({
      model: "openai-codex/gpt-5.5",
      sidebar: {
        models: [{ id: "openai-codex/gpt-5.5", label: "GPT-5.5" }],
      },
      messages: [
        { id: "u1", role: "user", text: "hi" },
        { id: "a1", role: "agent", text: "restored answer" },
      ],
      transcriptVisibility: { toolCalls: "group-block" },
    });

    expect(screen.getByText("GPT-5.5")).toBeTruthy();
    expect(screen.queryByText("AI")).toBeNull();
  });

  it("refreshes assistant model labels when model metadata arrives later", () => {
    const messages = [
      { id: "u1", role: "user", text: "hi" },
      {
        id: "a1",
        role: "agent",
        text: "done",
        model: "openai-codex/gpt-5.5",
      },
    ];
    const registry = new ExtensionRegistry();
    const { rerender } = render(
      groupedHistoryElement(
        {
          model: "openai-codex/gpt-5.5",
          sidebar: { models: [] },
          messages,
          transcriptVisibility: { toolCalls: "group-block" },
        },
        registry,
      ),
    );

    expect(screen.getByText("gpt-5.5")).toBeTruthy();

    rerender(
      groupedHistoryElement(
        {
          model: "openai-codex/gpt-5.5",
          sidebar: {
            models: [{ id: "openai-codex/gpt-5.5", label: "GPT-5.5" }],
          },
          messages,
          transcriptVisibility: { toolCalls: "group-block" },
        },
        registry,
      ),
    );

    expect(screen.getByText("GPT-5.5")).toBeTruthy();
    expect(screen.queryByText("gpt-5.5")).toBeNull();
  });

  it("expands turn activity into concrete tool rows", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-run" },
    });
    const collapsedLength = virtuosoMockState.dataLength;
    expect(collapsedLength).toBeTypeOf("number");

    fireEvent.click(screen.getByRole("button", { name: /2 tool calls/ }));

    expect(virtuosoMockState.dataLength).toBe(collapsedLength);
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
  });

  it("collapses tool output by default and reveals it on expand", () => {
    const { container } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "run command" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "raw command output" },
                  },
                ],
              },
            ],
          },
        },
        { id: "a1", role: "agent", text: "done" },
      ],
      transcriptVisibility: { toolCalls: "show" },
    });

    expect(screen.getByText("done")).toBeTruthy();
    // Tool cards collapse by default — stdout is hidden until expanded.
    expect(screen.queryByText("raw command output")).toBeNull();
    const cardSummary = container.querySelector(".ae-tool-card-summary");
    expect(cardSummary).toBeTruthy();
    fireEvent.click(cardSummary as Element);
    expect(screen.getByText("raw command output")).toBeTruthy();
  });

  it("keeps turn activity mounted briefly while collapsing", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-run" },
    });

    const summary = screen.getByRole("button", { name: /2 tool calls/ });
    fireEvent.click(summary);
    expect(screen.getByText("read")).toBeTruthy();

    fireEvent.click(summary);

    expect(summary.getAttribute("aria-expanded")).toBe("false");
    const closingBody = screen
      .getByText("read")
      .closest(".ae-turn-activity-body");
    expect(closingBody?.getAttribute("data-state")).toBe("closing");
  });

  it("keeps followOutput disabled when completed tool cards collapse into a group after user scroll-away", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-tool-card",
      components: { "tool-card": ToolCard },
    });
    const onEvent = vi.fn();
    const withHistory = (messages: unknown[]) => (
      <ExtensionRegistryProvider registry={registry}>
        <ChatHistory
          component={{
            id: "chat-history",
            type: "chat-history",
            props: { messages: { $ref: "/messages" } },
          }}
          state={{
            messages,
            transcriptVisibility: { toolCalls: "group-run" },
          }}
          onEvent={onEvent}
        />
      </ExtensionRegistryProvider>
    );
    const running = [
      { id: "u1", role: "user", text: "do tools" },
      {
        id: "t1",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "c1",
              type: "tool-card",
              props: { title: "read", startedAt: 1, endedAt: 2 },
            },
          ],
        },
      },
      {
        id: "t2",
        role: "agent",
        a2ui: {
          components: [
            {
              id: "c2",
              type: "tool-card",
              props: { title: "bash", startedAt: 3 },
            },
          ],
        },
      },
    ];
    const { rerender } = render(withHistory(running));

    // User scrolls away.
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    const scrollsBefore = virtuosoMockState.scrollToCalls.length;

    rerender(
      withHistory([
        running[0],
        running[1],
        {
          ...running[2],
          a2ui: {
            components: [
              {
                id: "c2",
                type: "tool-card",
                props: { title: "bash", startedAt: 3, endedAt: 4 },
              },
            ],
          },
        },
      ]),
    );

    expect(screen.getByText(/2 tool calls/)).toBeTruthy();
    // Collapsing the completed tools into a group must NOT re-pin or re-enable
    // follow while the user is reading scrolled-up.
    expect(virtuosoMockState.scrollToCalls.length).toBe(scrollsBefore);
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("group-turn shows a compact tool count in the activity row", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-turn" },
    });
    expect(screen.getByText(/2 tool calls/)).toBeTruthy();
    expect(screen.queryByText(/read · bash/)).toBeNull();
  });

  it("group-block keeps agent prose chronological and groups tool activity", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-block" },
    });
    expect(screen.getByText("reading files")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText(/2 tool calls/)).toBeTruthy();
    expect(screen.queryByText(/1 update/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 tool calls/ }));
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
  });

  it("expands completed file tools as one compact edit artifact", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit-1",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    preview:
                      "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old title\n+new title",
                    additions: 3,
                    deletions: 1,
                  },
                },
              },
            ],
          },
        },
        {
          id: "t2",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit-2",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 3,
                  endedAt: 5,
                  fileChange: {
                    kind: "edited",
                    path: "src/message-groups.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    expect(screen.getAllByText("Edited 2 files").length).toBeGreaterThan(1);
    const summary = screen.getByRole("button", { name: /Edited 2 files/ });
    expect(summary.textContent).toContain("Edited 2 files · +13 -3");
    expect(summary.textContent).not.toContain("tool call");
    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(screen.getByText("message-groups.tsx")).toBeTruthy();
    expect(screen.getAllByText("+13").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-3").length).toBeGreaterThan(0);
    expect(screen.queryByText("@@ -1 +1 @@")).toBeNull();

    const inlineDiffButton = screen.getByRole("button", {
      name: "Show inline diff for App.tsx",
    });
    expect(inlineDiffButton.querySelector("svg")).toBeTruthy();

    fireEvent.click(inlineDiffButton);
    expect(screen.getByText("+new title")).toBeTruthy();
    expect(screen.getByText("-old title")).toBeTruthy();
    expect(screen.getByText("@@ -1 +1 @@")).toBeTruthy();
    expect(screen.queryByText("Completed in 0.0s")).toBeNull();
  });

  it("aggregates repeated edit tools into one row per file with historical counts", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit-1",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    preview:
                      "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                  },
                },
              },
            ],
          },
        },
        {
          id: "t2",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit-2",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 3,
                  endedAt: 4,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    preview:
                      "diff --git a/src/App.tsx b/src/App.tsx\n@@ -8 +8 @@\n-before\n+after",
                    additions: 1,
                    deletions: 1,
                  },
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", { name: /Edited 1 file/ });
    expect(summary.textContent).toContain("Edited 1 file · +2 -2");
    expect(screen.getAllByText("App.tsx")).toHaveLength(1);
    expect(screen.getAllByText("+2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-2").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Show inline diff for App.tsx" }),
    );

    expect(screen.getByText("+new")).toBeTruthy();
    expect(screen.getByText("+after")).toBeTruthy();
  });

  it("forwards compact edit artifact file actions with the originating tool id", () => {
    const onEvent = vi.fn();
    render(
      groupedHistoryElement(
        {
          messages: [
            { id: "u1", role: "user", text: "change files" },
            {
              id: "t1",
              role: "agent",
              a2ui: {
                components: [
                  {
                    id: "tool-edit-1",
                    type: "tool-card",
                    props: {
                      title: "edit",
                      startedAt: 1,
                      endedAt: 2,
                      fileChange: {
                        kind: "edited",
                        path: "src/App.tsx",
                        rootPath: "/repo/aethon",
                        additions: 3,
                      },
                    },
                  },
                ],
              },
            },
          ],
          transcriptVisibility: { toolCalls: "group-block" },
        },
        new ExtensionRegistry(),
        onEvent,
      ),
    );

    fireEvent.click(screen.getByTitle("Open diff for src/App.tsx"));
    expect(onEvent).toHaveBeenCalledWith(
      "tool-file-diff",
      { filePath: "src/App.tsx", rootPath: "/repo/aethon" },
      "tool-edit-1",
    );

    fireEvent.click(screen.getByTitle("Open src/App.tsx"));
    expect(onEvent).toHaveBeenCalledWith(
      "tool-file-open",
      { filePath: "src/App.tsx", rootPath: "/repo/aethon" },
      "tool-edit-1",
    );
  });

  it("keeps tool-call-off edit expansion focused on file review", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-bash",
                type: "tool-card",
                props: {
                  title: "bash",
                  startedAt: 1,
                  endedAt: 2,
                },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "very noisy tool output" },
                  },
                ],
              },
            ],
          },
        },
        {
          id: "t2",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 3,
                  endedAt: 4,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    preview: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                  },
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", { name: /Edited 1 file/ });
    expect(summary.textContent).toContain("Edited 1 file");
    expect(summary.textContent).not.toContain("tool");

    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(screen.queryByText("bash")).toBeNull();
    expect(screen.queryByText("very noisy tool output")).toBeNull();
    expect(screen.queryByText("@@ -1 +1 @@")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show inline diff for App.tsx" }),
    );
    expect(screen.getByText("@@ -1 +1 @@")).toBeTruthy();
  });

  it("does not reserve empty progress rows for hidden thinking in edit artifacts", () => {
    const { container } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "thinking-1",
          role: "agent",
          model: "openai-codex/gpt-5.5",
          thinking: "private reasoning only",
        },
        {
          id: "thinking-2",
          role: "agent",
          model: "openai-codex/gpt-5.5",
          thinking: "more private reasoning only",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    preview: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                  },
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { thinking: "hide", toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", { name: /Edited 1 file/ });
    if (summary.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(summary);
    }

    expect(screen.queryByText("GPT-5.5")).toBeNull();
    expect(screen.queryByText("private reasoning only")).toBeNull();
    expect(container.querySelectorAll(".ae-turn-progress-message").length).toBe(
      0,
    );
    expect(container.querySelectorAll(".ae-file-activity-card").length).toBe(1);
  });

  it("keeps the completed edit artifacts card pinned regardless of the activity toggle", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    additions: 1,
                  },
                },
              },
            ],
          },
        },
      ],
      waiting: false,
      transcriptVisibility: { toolCalls: "hide" },
    });

    // The aggregated "Edited N files" card is a durable artifact — the file
    // is always listed regardless of the tool-calls toggle / turn collapse.
    expect(screen.getByText("App.tsx")).toBeTruthy();

    const summary = screen.getByRole("button", { name: /Edited 1 file/ });
    fireEvent.click(summary);

    // Collapsing the turn body must NOT hide the pinned edits card.
    expect(screen.getByText("App.tsx")).toBeTruthy();
  });

  it("does not rewrite compact edit artifact stats from the working tree", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_file_diff_stat"
        ? Promise.resolve({ insertions: 5, deletions: 2 })
        : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );

    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-edit",
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "edited",
                    path: "src/App.tsx",
                    rootPath: "/repo/aethon",
                  },
                },
              },
            ],
          },
        },
      ],
      transcriptVisibility: { toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", { name: /Edited 1 file/ });
    expect(summary.textContent).toContain("Edited 1 file");
    expect(summary.textContent).not.toContain("+5");
    expect(summary.textContent).not.toContain("-2");
    expect(invokeMock).not.toHaveBeenCalledWith("git_file_diff_stat", {
      root: "/repo/aethon",
      path: "src/App.tsx",
    });
  });

  it("keeps captured edit metadata stable when the working tree has richer stats", () => {
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, string>) => {
        if (cmd !== "git_file_diff_stat") {
          return Promise.reject(new Error(`invoke not mocked: ${cmd}`));
        }
        const stats: Record<string, { insertions: number; deletions: number }> =
          {
            "app/javascript/controllers/bulk_actions_controller.js": {
              insertions: 30,
              deletions: 2,
            },
            "app/views/admin/tracked_urls/index.html.erb": {
              insertions: 20,
              deletions: 3,
            },
            "spec/requests/admin/tracked_urls_spec.rb": {
              insertions: 32,
              deletions: 6,
            },
            "spec/javascript/controllers/bulk_actions_controller_spec.rb": {
              insertions: 15,
              deletions: 0,
            },
          };
        return Promise.resolve(
          stats[args.path] ?? { insertions: 0, deletions: 0 },
        );
      },
    );

    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "change files" },
        ...[
          "app/javascript/controllers/bulk_actions_controller.js",
          "app/views/admin/tracked_urls/index.html.erb",
          "spec/requests/admin/tracked_urls_spec.rb",
          "spec/javascript/controllers/bulk_actions_controller_spec.rb",
        ].map((path, index) => ({
          id: `t${index + 1}`,
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: `tool-edit-${index + 1}`,
                type: "tool-card",
                props: {
                  title: "edit",
                  startedAt: index + 1,
                  endedAt: index + 2,
                  fileChange: {
                    kind: "edited",
                    path,
                    rootPath: "/repo/nyc-real-estate",
                    ...(index === 3 ? { additions: 15 } : {}),
                  },
                },
              },
            ],
          },
        })),
      ],
      vcs: {
        root: "/repo/nyc-real-estate",
        changes: {
          insertions: 97,
          deletions: 11,
          files: [
            { path: "app/javascript/controllers/bulk_actions_controller.js" },
            { path: "app/views/admin/tracked_urls/index.html.erb" },
            { path: "spec/requests/admin/tracked_urls_spec.rb" },
            {
              path: "spec/javascript/controllers/bulk_actions_controller_spec.rb",
            },
          ],
        },
      },
      transcriptVisibility: { toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", {
      name: /Edited 4 files/,
    });
    expect(summary.textContent).toContain("Edited 4 files · +15");
    expect(summary.textContent).not.toContain("+97");
    expect(summary.textContent).not.toContain("-11");
    expect(invokeMock).not.toHaveBeenCalledWith("git_file_diff_stat", {
      root: "/repo/nyc-real-estate",
      path: "app/javascript/controllers/bulk_actions_controller.js",
    });
  });

  it("keeps captured counts for created files when git reports no tracked diff", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_file_diff_stat"
        ? Promise.resolve({ insertions: 0, deletions: 0 })
        : Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );

    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "create file" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-write",
                type: "tool-card",
                props: {
                  title: "write",
                  startedAt: 1,
                  endedAt: 2,
                  fileChange: {
                    kind: "created",
                    path: "src/new-file.ts",
                    rootPath: "/repo/aethon",
                    additions: 12,
                  },
                },
              },
            ],
          },
        },
      ],
      vcs: {
        root: "/repo/aethon",
        changes: {
          insertions: 0,
          deletions: 0,
          files: [{ path: "src/new-file.ts", status: "untracked" }],
        },
      },
      transcriptVisibility: { toolCalls: "hide" },
    });

    const summary = screen.getByRole("button", { name: /Created 1 file/ });
    expect(summary.textContent).toContain("Created 1 file · +12");
    expect(screen.getAllByText("+12").length).toBeGreaterThan(0);
    expect(invokeMock).not.toHaveBeenCalledWith("git_file_diff_stat", {
      root: "/repo/aethon",
      path: "src/new-file.ts",
    });
  });

  it("renders captured inline diffs without fetching or persisting live git snapshots", () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.reject(new Error(`invoke not mocked: ${cmd}`)),
    );
    const onEvent = vi.fn();

    render(
      groupedHistoryElement(
        {
          messages: [
            { id: "u1", role: "user", text: "change files" },
            {
              id: "t1",
              role: "agent",
              a2ui: {
                components: [
                  {
                    id: "tool-edit",
                    type: "tool-card",
                    props: {
                      title: "edit",
                      startedAt: 1,
                      endedAt: 2,
                      fileChange: {
                        kind: "edited",
                        path: "src/App.tsx",
                        rootPath: "/repo/aethon",
                        preview:
                          "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old title\n+new title\n",
                        additions: 1,
                        deletions: 1,
                      },
                    },
                  },
                ],
              },
            },
          ],
          transcriptVisibility: { toolCalls: "hide" },
        },
        new ExtensionRegistry(),
        onEvent,
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show inline diff for App.tsx" }),
    );

    expect(screen.getByText("+new title")).toBeTruthy();
    expect(screen.getByText("-old title")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "git_file_diff",
      expect.anything(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent_command",
      expect.anything(),
    );

    fireEvent.click(screen.getByTitle("Open diff for src/App.tsx"));
    expect(onEvent).toHaveBeenCalledWith(
      "tool-file-diff",
      {
        filePath: "src/App.tsx",
        rootPath: "/repo/aethon",
        diffSnapshot: {
          format: "unified",
          content:
            "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old title\n+new title\n",
          additions: 1,
          deletions: 1,
          source: "tool-card",
        },
      },
      "tool-edit",
    );
  });

  it("keeps stopped generic tool output hidden when tool calls are off", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "a1",
          role: "agent",
          text: "I’ll inspect the branch diff and relevant files.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "mixed stop command output" },
                  },
                ],
              },
            ],
          },
        },
        {
          id: "stop",
          role: "system",
          text: "Agent stopped.",
          createdAt: 2,
        },
      ],
      waiting: false,
      transcriptVisibility: { toolCalls: "hide" },
    });

    expect(
      screen.getByText("I’ll inspect the branch diff and relevant files."),
    ).toBeTruthy();
    expect(screen.queryByText("bash")).toBeNull();
    expect(screen.queryByText("mixed stop command output")).toBeNull();
    expect(screen.queryByRole("button", { name: /1 tool call/ })).toBeNull();
  });

  it("keeps stopped assistant progress visible and expanded when there is no final answer", () => {
    const { container } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "a1",
          role: "agent",
          text: "I’ll inspect the branch diff and relevant files.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "a2",
          role: "agent",
          text: "I don’t see any uncommitted changes.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "mixed stop command output" },
                  },
                ],
              },
            ],
          },
        },
        {
          id: "stop",
          role: "system",
          text: "Agent stopped.",
          createdAt: 2,
        },
      ],
      waiting: false,
      transcriptVisibility: { toolCalls: "group-block" },
    });

    expect(
      screen.getByText("I’ll inspect the branch diff and relevant files."),
    ).toBeTruthy();
    expect(
      screen.getByText("I don’t see any uncommitted changes."),
    ).toBeTruthy();
    expect(screen.getByText(/1 tool call/)).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    // The turn stays expanded; the tool card itself is collapsed by default,
    // so its stdout is revealed only after expanding the card.
    expect(
      screen
        .getByRole("button", { name: /1 tool call/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByText("mixed stop command output")).toBeNull();
    const cardSummary = container.querySelector(".ae-tool-card-summary");
    expect(cardSummary).toBeTruthy();
    fireEvent.click(cardSummary as Element);
    expect(screen.getByText("mixed stop command output")).toBeTruthy();
  });

  it("keeps prior assistant prose visible when the latest agent row is hidden thinking", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "a1",
          role: "agent",
          text: "I’ll inspect the branch diff and relevant files.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
              },
            ],
          },
        },
        {
          id: "thinking-tail",
          role: "agent",
          thinking: "I am about to summarize, but the user stopped me.",
        },
      ],
      waiting: false,
      transcriptVisibility: { thinking: "hide", toolCalls: "group-block" },
    });

    expect(
      screen.getByText("I’ll inspect the branch diff and relevant files."),
    ).toBeTruthy();
    expect(
      screen.queryByText("I am about to summarize, but the user stopped me."),
    ).toBeNull();
    expect(screen.getByText(/1 tool call/)).toBeTruthy();
  });

  it("keeps interrupted progress prose visible when stop status has already reset", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "a1",
          role: "agent",
          text: "I’ll inspect the branch diff and relevant files.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "a2",
          role: "agent",
          text: "I don’t see any uncommitted changes.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
              },
            ],
          },
        },
        {
          id: "thinking-tail",
          role: "agent",
          thinking: "I was stopped before writing the final answer.",
        },
      ],
      waiting: false,
      status: "ready",
      transcriptVisibility: { thinking: "hide", toolCalls: "group-block" },
    });

    expect(
      screen.getByText("I’ll inspect the branch diff and relevant files."),
    ).toBeTruthy();
    expect(
      screen.getByText("I don’t see any uncommitted changes."),
    ).toBeTruthy();
    expect(
      screen.queryByText("I was stopped before writing the final answer."),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /1 tool call/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("bash")).toBeNull();
  });

  it("keeps interrupted tool output visible when stop happens before prose", () => {
    const { container } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "review output before stop" },
                  },
                ],
              },
            ],
          },
        },
        {
          id: "thinking-tail",
          role: "agent",
          thinking: "I was stopped before writing visible prose.",
        },
      ],
      waiting: false,
      status: "ready",
      transcriptVisibility: { thinking: "hide", toolCalls: "group-block" },
    });

    const summary = screen.getByRole("button", { name: /1 tool call/ });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("bash")).toBeTruthy();
    // Collapsed by default; expanding the card reveals the interrupted output.
    expect(screen.queryByText("review output before stop")).toBeNull();
    const cardSummary = container.querySelector(".ae-tool-card-summary");
    expect(cardSummary).toBeTruthy();
    fireEvent.click(cardSummary as Element);
    expect(screen.getByText("review output before stop")).toBeTruthy();
  });

  it("expand-all reveals every tool card in the turn", () => {
    const mkCard = (id: string, out: string) => ({
      id,
      type: "tool-card" as const,
      props: { title: "bash", startedAt: 1, endedAt: 2 },
      children: [{ id: `${id}-o`, type: "code", props: { content: out } }],
    });
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "go" },
        {
          id: "t1",
          role: "agent",
          a2ui: { components: [mkCard("c1", "first out"), mkCard("c2", "second out")] },
        },
      ],
      waiting: false,
      status: "ready",
      transcriptVisibility: { toolCalls: "group-block" },
    });

    // Expand the turn body to surface the tool cards + the toolbar.
    const turnHeader = screen.getByRole("button", { name: /tool call/ });
    if (turnHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(turnHeader);
    }
    // Cards are still collapsed individually by default.
    expect(screen.queryByText("first out")).toBeNull();
    expect(screen.queryByText("second out")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));

    // The per-turn toolbar expands every card in its own subtree.
    expect(screen.getByText("first out")).toBeTruthy();
    expect(screen.getByText("second out")).toBeTruthy();
  });

  it("keeps the latest stopped status turn expanded when no stop notice is in the transcript", () => {
    renderGroupedHistory({
      status: "stopped",
      messages: [
        { id: "u1", role: "user", text: "Review this implementation" },
        {
          id: "a1",
          role: "agent",
          text: "I’ll inspect the branch diff and relevant files.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "a2",
          role: "agent",
          text: "I don’t see any uncommitted changes.",
          model: "openai-codex/gpt-5.5",
        },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "c1",
                type: "tool-card",
                props: { title: "bash", startedAt: 1, endedAt: 2 },
              },
            ],
          },
        },
      ],
      waiting: false,
      transcriptVisibility: { toolCalls: "group-block" },
    });

    expect(
      screen.getByText("I’ll inspect the branch diff and relevant files."),
    ).toBeTruthy();
    expect(
      screen.getByText("I don’t see any uncommitted changes."),
    ).toBeTruthy();
    expect(screen.getByText(/1 tool call/)).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /1 tool call/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("does not animate restored rows on the first rendered transcript", () => {
    renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "restored request" },
        { id: "a1", role: "agent", text: "restored answer" },
      ],
      transcriptVisibility: { toolCalls: "group-block" },
    });

    expect(document.querySelector(".a2ui-msg-row-enter")).toBeNull();
  });

  it("marks only appended rows for transcript entrance motion", () => {
    const initialState = {
      messages: [
        { id: "u1", role: "user", text: "restored request" },
        { id: "a1", role: "agent", text: "restored answer" },
      ],
      transcriptVisibility: { toolCalls: "group-block" },
    };
    const registry = new ExtensionRegistry();
    const { rerender } = render(groupedHistoryElement(initialState, registry));

    expect(document.querySelector(".a2ui-msg-row-enter")).toBeNull();

    rerender(
      groupedHistoryElement(
        {
          ...initialState,
          messages: [
            ...initialState.messages,
            { id: "u2", role: "user", text: "new request" },
          ],
        },
        registry,
      ),
    );

    const enteredRows = document.querySelectorAll(".a2ui-msg-row-enter");
    expect(enteredRows).toHaveLength(1);
    expect(enteredRows[0].textContent).toContain("new request");
  });

  it("hide drops tool cards while keeping agent prose chronological", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "hide" },
    });
    expect(screen.queryByText("2 tool calls")).toBeNull();
    expect(screen.queryByText("read")).toBeNull();
    expect(screen.queryByText("bash")).toBeNull();
    expect(screen.getByText("reading files")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1 update/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Earlier progress/ }),
    ).toBeNull();
  });

  it("hide still surfaces live running tool activity without persisting tool details", () => {
    const { container } = renderGroupedHistory({
      messages: [
        { id: "u1", role: "user", text: "inspect files" },
        { id: "a1", role: "agent", text: "I’ll inspect the repo." },
        {
          id: "t1",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-bash",
                type: "tool-card",
                props: {
                  title: "bash",
                  description: "rg message-row",
                  startedAt: 1000,
                },
                children: [
                  {
                    id: "out",
                    type: "code",
                    props: { content: "raw running output" },
                  },
                ],
              },
            ],
          },
        },
      ],
      waiting: true,
      transcriptVisibility: { toolCalls: "hide" },
    });

    expect(screen.getByText("Searching files")).toBeTruthy();
    expect(screen.getByText("Looking for relevant matches")).toBeTruthy();
    expect(screen.queryByText("bash")).toBeNull();
    expect(screen.queryByText("rg message-row")).toBeNull();
    expect(screen.queryByText("raw running output")).toBeNull();
    expect(container.querySelector(".ae-live-activity-card")).toBeTruthy();
  });

  it("show expands activity by default", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "show" },
    });
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
  });
});

describe("filter toggle re-anchoring (mocked Virtuoso)", () => {
  const registry = new ExtensionRegistry();
  registry.register({
    name: "test-tool-card",
    components: { "tool-card": ToolCard },
  });

  // Turn indices: intro(0), tool turn(1). Message anchors inside a turn map
  // back to the containing turn row when visibility changes.
  const messages = [
    { id: "u0", role: "user", text: "intro" },
    { id: "a0", role: "agent", text: "previous answer" },
    { id: "u1", role: "user", text: "do tools" },
    { id: "a1", role: "agent", text: "reading" },
    {
      id: "t1",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "c1",
            type: "tool-card",
            props: { title: "read", startedAt: 1, endedAt: 2 },
          },
        ],
      },
    },
    {
      id: "t2",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "c2",
            type: "tool-card",
            props: { title: "bash", startedAt: 1, endedAt: 2 },
          },
        ],
      },
    },
    { id: "a2", role: "agent", text: "done" },
  ];

  const withVis = (mode: string) => (
    <ExtensionRegistryProvider registry={registry}>
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{ messages, transcriptVisibility: { toolCalls: mode } }}
        onEvent={vi.fn()}
      />
    </ExtensionRegistryProvider>
  );

  it("re-pins to the bottom when a filter changes while following", () => {
    const { rerender } = render(withVis("show"));
    // Following by default (no user scroll-away).
    rerender(withVis("group-run"));
    const scroller = screen.getByTestId("virtuoso-mock");
    expect(
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    ).toBe(0);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("preserves the reading anchor when a filter changes while scrolled-up", () => {
    const { rerender } = render(withVis("show"));
    // Topmost visible row is the tool turn; user has scrolled up.
    act(() => virtuosoMockState.rangeChanged?.({ startIndex: 1, endIndex: 4 }));
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    const before = virtuosoMockState.scrollToIndexCalls.length;

    rerender(withVis("group-run"));

    // The anchor maps back to the same containing turn and stays pinned to the
    // TOP (align "start") so the reading position is preserved.
    expect(virtuosoMockState.scrollToIndexCalls.length).toBeGreaterThanOrEqual(
      before,
    );
    const last = virtuosoMockState.scrollToIndexCalls.at(-1);
    expect(last).toMatchObject({ index: 1, align: "start" });
  });

  it("keeps the containing turn anchored when tool cards are hidden", () => {
    const { rerender } = render(withVis("show"));
    // Anchor on the tool turn; user has scrolled up.
    act(() => virtuosoMockState.rangeChanged?.({ startIndex: 1, endIndex: 2 }));
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    const before = virtuosoMockState.scrollToIndexCalls.length;

    rerender(withVis("hide"));

    // hide drops t1/t2, but the anchor survives through the containing turn.
    expect(virtuosoMockState.scrollToIndexCalls.length).toBeGreaterThanOrEqual(
      before,
    );
    const last = virtuosoMockState.scrollToIndexCalls.at(-1);
    expect(last).toMatchObject({ index: 1, align: "start" });
  });
});

describe("stale per-tab restore anchor (mocked Virtuoso)", () => {
  const view = (tabId: string, messages: unknown[]) => (
    <ChatHistory
      component={{
        id: "chat-history",
        type: "chat-history",
        props: { messages: { $ref: "/messages" } },
      }}
      state={{ messages }}
      tabId={tabId}
      onEvent={vi.fn()}
    />
  );

  it("resumes following + pins to bottom when the cached anchor message is gone", () => {
    const tabId = "stale-anchor-tab";
    const full = [
      { id: "u1", role: "user", text: "one" },
      { id: "a1", role: "agent", text: "two" },
      { id: "u2", role: "user", text: "three" },
      { id: "a2", role: "agent", text: "four" },
    ];
    const { rerender } = render(view(tabId, full));

    // User scrolls up anchoring on "a1" (index 1) — caches it for this tab.
    act(() => virtuosoMockState.rangeChanged?.({ startIndex: 1, endIndex: 3 }));
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
    const before = virtuosoMockState.scrollToCalls.length;

    // The chat is cleared / rolled back so the anchored message no longer exists
    // (still a scrollable transcript, so a hidden pill reflects follow, not size).
    rerender(
      view(tabId, [
        { id: "u9", role: "user", text: "fresh one" },
        { id: "a9", role: "agent", text: "fresh two" },
        { id: "u10", role: "user", text: "fresh three" },
      ]),
    );

    // Stale anchor detected → cache dropped, follow resumes, pinned to bottom.
    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });
});
