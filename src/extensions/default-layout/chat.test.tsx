// @vitest-environment jsdom
import { forwardRef, useEffect, useImperativeHandle } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatHistory,
  ChatInput,
  QueuedMessagesPopover,
  ToolCard,
} from "./chat";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));

const virtuosoMockState = vi.hoisted(
  (): {
    followOutput?: unknown;
    scrollToCalls: unknown[];
    scrollToIndexCalls: unknown[];
    // Virtuoso callbacks captured so tests can drive at-bottom / range
    // transitions explicitly (the real library is the sole at-bottom signal).
    atBottomStateChange?: (atBottom: boolean) => void;
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
    totalListHeightChanged?: (height: number) => void;
  } => ({
    followOutput: undefined,
    scrollToCalls: [],
    scrollToIndexCalls: [],
    atBottomStateChange: undefined,
    rangeChanged: undefined,
    totalListHeightChanged: undefined,
  }),
);

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
        followOutput,
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
        followOutput?: unknown;
      },
      ref,
    ) => {
      const Footer = components?.Footer;
      virtuosoMockState.followOutput = followOutput;
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

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  openUrl.mockResolvedValue(undefined);
  virtuosoMockState.followOutput = undefined;
  virtuosoMockState.scrollToCalls = [];
  virtuosoMockState.scrollToIndexCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

function renderInput(
  onEvent = vi.fn(),
  props: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  // ChatInput resolves the queued-messages popover via
  // `useExtensionRegistry().resolve(...)` and renders it with
  // `createElement`, which means the test needs a real ExtensionRegistry
  // in context with the popover registered — otherwise the resolver
  // returns undefined and the popover stays unmounted even when the
  // test fixture seeds `state.queuedMessages`. Registering it here
  // exercises the production wiring.
  const registry = new ExtensionRegistry();
  registry.register({
    name: "test-default-layout",
    components: { "queued-messages-popover": QueuedMessagesPopover },
  });
  const result = render(
    <ExtensionRegistryProvider registry={registry}>
      <ChatInput
        component={{
          id: "chat-input",
          type: "chat-input",
          props: { value: "", placeholder: "Message", ...props },
        }}
        state={state}
        onEvent={onEvent}
      />
    </ExtensionRegistryProvider>,
  );
  return {
    input: screen.getByPlaceholderText("Message"),
    onEvent,
    ...result,
  };
}

function renderHistory(state: Record<string, unknown>) {
  const onEvent = vi.fn();
  const result = render(
    <ChatHistory
      component={{
        id: "chat-history",
        type: "chat-history",
        props: { messages: { $ref: "/messages" } },
      }}
      state={state}
      onEvent={onEvent}
    />,
  );
  return { onEvent, ...result };
}

function setScrollTop(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", {
    value: top,
    writable: true,
    configurable: true,
  });
}

// Simulate a genuine user scroll-away: a gesture (wheel) then a scroll event at
// a non-bottom position. The component only honors gesture-flagged scrolls.
function userScrollUp(el: HTMLElement) {
  fireEvent.wheel(el);
  setScrollTop(el, 0);
  fireEvent.scroll(el);
}

// Simulate the user scrolling back to the bottom.
function userScrollToBottom(el: HTMLElement) {
  fireEvent.wheel(el);
  setScrollTop(el, el.scrollHeight - el.clientHeight);
  fireEvent.scroll(el);
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

    renderToolCard({ startedAt: 1_000, endedAt: 3_000, status: "cancelled" });

    expect(screen.getByText("Cancelled in 2.0s")).toBeTruthy();
    expect(screen.queryByText(/long-running/)).toBeNull();
    expect(screen.getByLabelText("Tool cancelled")).toBeTruthy();

    vi.setSystemTime(30_000);
    vi.advanceTimersByTime(1_000);

    expect(screen.getByText("Cancelled in 2.0s")).toBeTruthy();
  });

  it("renders completed and failed terminal states with stable durations", () => {
    const { rerender } = renderToolCard({ startedAt: 1_000, endedAt: 2_500 });
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
    expect(screen.getByLabelText("Tool failed")).toBeTruthy();
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

  it("keeps the latest pill hidden when the feed is not scrollable", () => {
    renderHistory({
      messages: [{ id: "1", role: "agent", text: "short answer" }],
    });

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
  });

  it("starts pinned to latest: pill hidden, Virtuoso followOutput disabled", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
    // The controller owns scrolling; Virtuoso's own follow is off so it never
    // double-scrolls or emits spurious not-at-bottom on reflow.
    expect(virtuosoMockState.followOutput).toBe(false);
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

    const before = virtuosoMockState.scrollToCalls.length;
    // Content grew (e.g. a streamed token) → totalListHeightChanged fires.
    act(() => virtuosoMockState.totalListHeightChanged?.(2000));

    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
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
});

describe("ChatInput @file completion", () => {
  const WALK = ["/proj/src/App.tsx", "/proj/src/main.tsx", "/proj/README.md"];

  beforeEach(() => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fs_walk_project"
        ? Promise.resolve(WALK)
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

describe("ChatHistory tool-call grouping (mocked Virtuoso renders rows)", () => {
  // Two completed tool-using turns plus a final live-ish turn; the bridge
  // emits each tool call as its own role:"agent" message carrying a tool-card.
  const toolMessages = [
    { id: "u1", role: "user", text: "do the thing" },
    { id: "a1", role: "agent", text: "reading files" },
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
    { id: "u2", role: "user", text: "now this" },
    {
      id: "t3",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "c3",
            type: "tool-card",
            props: { title: "edit", startedAt: 1, endedAt: 2 },
          },
        ],
      },
    },
  ];

  // Single tool cards render through A2UIRenderer, which resolves the
  // `tool-card` component from the registry — so wrap in a provider that has it.
  function renderGroupedHistory(state: Record<string, unknown>) {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-tool-card",
      components: { "tool-card": ToolCard },
    });
    return render(
      <ExtensionRegistryProvider registry={registry}>
        <ChatHistory
          component={{
            id: "chat-history",
            type: "chat-history",
            props: { messages: { $ref: "/messages" } },
          }}
          state={state}
          onEvent={vi.fn()}
        />
      </ExtensionRegistryProvider>,
    );
  }

  it("group-run folds the consecutive run into a '2 tool calls' cluster", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-run" },
    });
    expect(screen.getByText("2 tool calls")).toBeTruthy();
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

    expect(screen.getByText("2 tool calls")).toBeTruthy();
    // Collapsing the completed tools into a group must NOT re-pin or re-enable
    // follow while the user is reading scrolled-up.
    expect(virtuosoMockState.scrollToCalls.length).toBe(scrollsBefore);
    expect(
      screen.getByRole("button", { name: "Scroll to latest message" }),
    ).toBeTruthy();
  });

  it("group-turn folds a turn's tools into one cluster with a name peek", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-turn" },
    });
    expect(screen.getByText("2 tool calls")).toBeTruthy();
    expect(screen.getByText("read · bash")).toBeTruthy();
  });

  it("group-block folds the first completed turn into an 'Agent turn' block", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "group-block" },
    });
    expect(screen.getByText("Agent turn")).toBeTruthy();
    // Meta counts only text-bearing replies (a1 "reading files" + a2 "done").
    expect(screen.getByText("2 replies · 2 tool calls")).toBeTruthy();
    // The last turn stays expanded, so no group label wraps its single tool.
    expect(screen.queryByText("1 tool call")).toBeNull();
  });

  it("hide drops tool cards and never renders a group label", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "hide" },
    });
    expect(screen.queryByText("2 tool calls")).toBeNull();
    expect(screen.queryByText("Agent turn")).toBeNull();
    // Narration stays.
    expect(screen.getByText("reading files")).toBeTruthy();
  });

  it("show renders tool cards individually with no grouping chrome", () => {
    renderGroupedHistory({
      messages: toolMessages,
      transcriptVisibility: { toolCalls: "show" },
    });
    expect(screen.queryByText("2 tool calls")).toBeNull();
    expect(screen.queryByText("Agent turn")).toBeNull();
  });
});

describe("filter toggle re-anchoring (mocked Virtuoso)", () => {
  const registry = new ExtensionRegistry();
  registry.register({
    name: "test-tool-card",
    components: { "tool-card": ToolCard },
  });

  // show-mode group indices: u1(0) a1(1) t1(2) t2(3) a2(4).
  const messages = [
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
    const before = virtuosoMockState.scrollToCalls.length;
    rerender(withVis("group-run"));
    // The following branch pins to the true bottom via scrollTo({ top: MAX }).
    expect(virtuosoMockState.scrollToCalls.length).toBeGreaterThan(before);
    expect(virtuosoMockState.scrollToCalls).toContainEqual({
      top: Number.MAX_SAFE_INTEGER,
    });
  });

  it("preserves the reading anchor when a filter changes while scrolled-up", () => {
    const { rerender } = render(withVis("show"));
    // Topmost visible row is "a1" (show index 1); user has scrolled up.
    act(() => virtuosoMockState.rangeChanged?.({ startIndex: 1, endIndex: 4 }));
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    const before = virtuosoMockState.scrollToIndexCalls.length;

    rerender(withVis("group-run"));

    // group-run keeps "a1" a single, so the anchor maps to its new index and is
    // pinned to the TOP (align "start") — the reading position is preserved.
    expect(virtuosoMockState.scrollToIndexCalls.length).toBeGreaterThan(before);
    const last = virtuosoMockState.scrollToIndexCalls.at(-1);
    expect(last).toMatchObject({ index: 1, align: "start" });
  });

  it("falls back to a surviving ancestor when the anchored tool card is hidden", () => {
    const { rerender } = render(withVis("show"));
    // Anchor ON the tool card "t1" (show index 2); user has scrolled up.
    act(() => virtuosoMockState.rangeChanged?.({ startIndex: 2, endIndex: 4 }));
    act(() => userScrollUp(screen.getByTestId("virtuoso-mock")));
    const before = virtuosoMockState.scrollToIndexCalls.length;

    rerender(withVis("hide"));

    // hide drops t1/t2; the anchor disappears, so we fall back to the nearest
    // preceding survivor "a1" (hide index 1), still pinned to the top.
    expect(virtuosoMockState.scrollToIndexCalls.length).toBeGreaterThan(before);
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
