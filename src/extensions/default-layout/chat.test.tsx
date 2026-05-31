// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const virtuosoMockState = vi.hoisted((): { followOutput?: unknown } => ({
  followOutput: undefined,
}));

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
  Virtuoso: ({
    data = [],
    itemContent,
    components,
    context,
    className,
    atBottomStateChange,
    scrollerRef,
    totalListHeightChanged,
    followOutput,
  }: {
    data?: Array<{ id?: string }>;
    itemContent: (index: number, item: unknown) => React.ReactNode;
    components?: { Footer?: (props: { context?: unknown }) => React.ReactNode };
    context?: unknown;
    className?: string;
    atBottomStateChange?: (atBottom: boolean) => void;
    scrollerRef?: (ref: HTMLElement | null) => void;
    totalListHeightChanged?: (height: number) => void;
    followOutput?: unknown;
  }) => {
    const Footer = components?.Footer;
    virtuosoMockState.followOutput = followOutput;
    useEffect(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-testid='virtuoso-mock']",
      );
      if (el) {
        Object.defineProperties(el, {
          scrollHeight: { value: 1000, configurable: true },
          clientHeight: { value: 500, configurable: true },
          scrollTop: {
            value: 470,
            writable: true,
            configurable: true,
          },
        });
      }
      scrollerRef?.(el);
      totalListHeightChanged?.(0);
      atBottomStateChange?.(false);
      return () => scrollerRef?.(null);
    }, [atBottomStateChange, scrollerRef, totalListHeightChanged]);
    return (
      <div className={className} data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={item.id ?? index}>{itemContent(index, item)}</div>
        ))}
        {Footer ? <Footer context={context} /> : null}
      </div>
    );
  },
}));
import { ExtensionRegistry } from "../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../ExtensionRegistryProvider";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  openUrl.mockResolvedValue(undefined);
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
  render(
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
  return { onEvent };
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

  it("keeps following latest when Virtuoso reports false before a user scrolls away", () => {
    renderHistory({
      messages: [
        { id: "1", role: "user", text: "start" },
        { id: "2", role: "agent", text: "streaming update" },
      ],
    });

    expect(
      screen.queryByRole("button", { name: "Scroll to latest message" }),
    ).toBeNull();
    expect(virtuosoMockState.followOutput).toEqual(expect.any(Function));
    expect((virtuosoMockState.followOutput as () => unknown)()).toBe("smooth");
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
