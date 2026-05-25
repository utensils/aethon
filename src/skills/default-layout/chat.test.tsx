// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistory, ChatInput, QueuedMessagesPopover, ToolCard } from "./chat";
import { SkillRegistry } from "../../skills/SkillRegistry";
import { SkillRegistryProvider } from "../../skills/registry";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInput(
  onEvent = vi.fn(),
  props: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  // ChatInput resolves the queued-messages popover via
  // `useSkillRegistry().resolve(...)` and renders it with
  // `createElement`, which means the test needs a real SkillRegistry
  // in context with the popover registered — otherwise the resolver
  // returns undefined and the popover stays unmounted even when the
  // test fixture seeds `state.queuedMessages`. Registering it here
  // exercises the production wiring.
  const registry = new SkillRegistry();
  registry.register({
    name: "test-default-layout",
    components: { "queued-messages-popover": QueuedMessagesPopover },
  });
  render(
    <SkillRegistryProvider registry={registry}>
      <ChatInput
        component={{
          id: "chat-input",
          type: "chat-input",
          props: { value: "", placeholder: "Message", ...props },
        }}
        state={state}
        onEvent={onEvent}
      />
    </SkillRegistryProvider>,
  );
  return {
    input: screen.getByPlaceholderText("Message"),
    onEvent,
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
    vi.useRealTimers();
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

  it("does not submit shift-enter", () => {
    const { input, onEvent } = renderInput();

    fireEvent.change(input, { target: { value: "new line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onEvent).not.toHaveBeenCalledWith("submit", expect.any(Object));
  });

  it("shows the running-turn shortcut hint only when busy", () => {
    renderInput(vi.fn(), { disabled: { $ref: "/waiting" } }, { waiting: true });

    expect(screen.getByText("Enter queues")).toBeTruthy();
    expect(screen.getByText("Cmd/Ctrl+Enter steers")).toBeTruthy();

    cleanup();
    renderInput(vi.fn(), { disabled: { $ref: "/waiting" } }, { waiting: false });
    expect(screen.queryByText("Enter queues")).toBeNull();
  });

  it("makes stop queue-clearing behavior visible when follow-ups are queued", () => {
    renderInput(
      vi.fn(),
      { disabled: { $ref: "/waiting" }, queueCount: { $ref: "/queueCount" } },
      { waiting: true, queueCount: 2 },
    );

    expect(
      screen.getByRole("button", { name: "Stop + clear" }).getAttribute("title"),
    ).toBe("Stop the current prompt and clear 2 messages queued");
    expect(screen.getByText("+2").getAttribute("title")).toBe(
      "2 messages queued behind the current prompt",
    );
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
});
