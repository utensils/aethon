import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ChatHistory, ChatInput, MainCanvas, QueuedMessagesPopover, ToolCard } from "./chat";
import { ExtensionRegistry } from "../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../ExtensionRegistryProvider";
import type { ChatMessage } from "../../types/a2ui";

export const textMessage = (
  id: string,
  role: ChatMessage["role"],
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({ id, role, text, ...overrides });

export const toolMessage = (
  id: string,
  title: string,
  props: Record<string, unknown> = {},
): ChatMessage => ({
  id,
  role: "agent",
  a2ui: {
    components: [
      {
        id: `card-${id}`,
        type: "tool-card",
        props: { title, startedAt: 1, endedAt: 2, ...props },
      },
    ],
  },
});

export function toolTranscript(): ChatMessage[] {
  return [
    textMessage("u1", "user", "do the thing"),
    textMessage("a1", "agent", "reading files"),
    toolMessage("t1", "read"),
    toolMessage("t2", "bash"),
    textMessage("a2", "agent", "done"),
    textMessage("u2", "user", "now this"),
    toolMessage("t3", "edit"),
  ];
}

export function makeTextTranscript(count: number, prefix = "message") {
  return Array.from({ length: count }, (_, i) =>
    textMessage(`m${i}`, i % 2 === 0 ? "user" : "agent", `${prefix} ${i}`),
  );
}

export function renderChatInput(
  onEvent = vi.fn(),
  props: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  // ChatInput resolves the queued-messages popover via the extension registry;
  // registering it here exercises the same production wiring as the app.
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
        tabId="tab-1"
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

export function chatHistoryElement(
  state: Record<string, unknown>,
  onEvent = vi.fn(),
) {
  return (
    <ChatHistory
      component={{
        id: "chat-history",
        type: "chat-history",
        props: { messages: { $ref: "/messages" } },
      }}
      state={state}
      onEvent={onEvent}
    />
  );
}

export function renderChatHistory(state: Record<string, unknown>) {
  const onEvent = vi.fn();
  return { onEvent, ...render(chatHistoryElement(state, onEvent)) };
}

export function groupedHistoryElement(
  state: Record<string, unknown>,
  registry = new ExtensionRegistry(),
  onEvent = vi.fn(),
) {
  // Single tool cards render through A2UIRenderer, which resolves the
  // `tool-card` component from the registry — so wrap in a provider that has it.
  registry.register({
    name: "test-tool-card",
    components: { "tool-card": ToolCard },
  });
  return (
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
}

export function renderGroupedHistory(state: Record<string, unknown>) {
  return render(groupedHistoryElement(state));
}

export function renderMainCanvas(
  state: Record<string, unknown>,
  tabId?: string,
) {
  return render(
    <MainCanvas
      component={{
        id: "main-canvas",
        type: "main-canvas",
        props: { messages: { $ref: "/messages" } },
      }}
      state={state}
      tabId={tabId}
      onEvent={vi.fn()}
    />,
  );
}

export function setScrollTop(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", {
    value: top,
    writable: true,
    configurable: true,
  });
}

export function setScrollerMetrics(
  el: HTMLElement,
  metrics: Partial<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }>,
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(el, key, {
      value,
      writable: key === "scrollTop",
      configurable: true,
    });
  }
}

// Simulate a genuine user scroll-away: a gesture (wheel) then a scroll event at
// a non-bottom position. The component only honors gesture-flagged scrolls.
export function userScrollUp(el: HTMLElement) {
  fireEvent.wheel(el);
  if (el.scrollHeight <= el.clientHeight) {
    setScrollerMetrics(el, {
      scrollHeight: el.clientHeight + 400,
      scrollTop: el.scrollTop,
    });
  }
  setScrollTop(el, 0);
  fireEvent.scroll(el);
}

// Simulate the user scrolling back to the bottom.
export function userScrollToBottom(el: HTMLElement) {
  fireEvent.wheel(el);
  setScrollTop(el, el.scrollHeight - el.clientHeight);
  fireEvent.scroll(el);
}

export interface MockVirtuosoState {
  alignToBottom?: unknown;
  followOutput?: unknown;
  scrollToCalls: unknown[];
  scrollToIndexCalls: unknown[];
  dataLength?: number;
  heightEstimates?: unknown;
  increaseViewportBy?: unknown;
  minOverscanItemCount?: unknown;
  atBottomStateChange?: (atBottom: boolean) => void;
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
  totalListHeightChanged?: (height: number) => void;
}

export function resetMockVirtuosoState(state: MockVirtuosoState) {
  state.followOutput = undefined;
  state.alignToBottom = undefined;
  state.scrollToCalls = [];
  state.scrollToIndexCalls = [];
  state.dataLength = undefined;
  state.heightEstimates = undefined;
  state.increaseViewportBy = undefined;
  state.minOverscanItemCount = undefined;
  state.atBottomStateChange = undefined;
  state.rangeChanged = undefined;
  state.totalListHeightChanged = undefined;
}

export interface ResizeObserverFixture {
  callbacks: Array<ResizeObserverCallback>;
  Mock: typeof ResizeObserver;
  trigger: () => void;
}

export function createResizeObserverFixture(): ResizeObserverFixture {
  const callbacks: Array<ResizeObserverCallback> = [];

  class ResizeObserverMock implements ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      callbacks.push(callback);
    }

    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn(() => {
      const index = callbacks.indexOf(this.callback);
      if (index >= 0) callbacks.splice(index, 1);
    });
  }

  return {
    callbacks,
    Mock: ResizeObserverMock,
    trigger: () => {
      for (const callback of callbacks) {
        callback([], {} as ResizeObserver);
      }
    },
  };
}
