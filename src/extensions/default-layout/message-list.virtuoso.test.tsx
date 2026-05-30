// @vitest-environment jsdom
//
// Integration guard for the REAL react-virtuoso wiring (chat.test.tsx mocks
// Virtuoso, so it can't catch measurement/prop-combination bugs). Codex caught
// a P1 here: pairing `initialItemCount` with a bottom `initialTopMostItemIndex`
// makes Virtuoso request rows past the end of `data` and pass `undefined` into
// computeItemKey, crashing on `m.id` whenever a 2+ message transcript mounts
// (session restore, opening any existing chat). This pins that it stays fixed.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistory, MainCanvas } from "./chat";

vi.mock("../../components/HighlightedCode", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(count: number) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "agent",
    text: `message ${i}`,
  }));
  return render(
    <ChatHistory
      component={{
        id: "chat-history",
        type: "chat-history",
        props: { messages: { $ref: "/messages" } },
      }}
      state={{ messages }}
      onEvent={vi.fn()}
    />,
  );
}

describe("ChatHistory + real Virtuoso", () => {
  it("mounts a multi-message transcript without crashing computeItemKey", () => {
    // The pre-fix prop combination threw TypeError on m.id here.
    expect(() => renderChat(50)).not.toThrow();
  });

  it("mounts a single-message transcript without crashing", () => {
    expect(() => renderChat(1)).not.toThrow();
  });

  it("mounts MainCanvas (Virtuoso + footer) without crashing", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      role: i % 2 === 0 ? "user" : "agent",
      text: `canvas message ${i}`,
    }));
    expect(() =>
      render(
        <MainCanvas
          component={{
            id: "main-canvas",
            type: "main-canvas",
            props: { messages: { $ref: "/messages" } },
          }}
          state={{ messages, waiting: false }}
          onEvent={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });

  it("renders the empty-state hint without Virtuoso", () => {
    const { getByText } = render(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: {
            messages: { $ref: "/messages" },
            emptyHint: "Start a conversation.",
          },
        }}
        state={{ messages: [] }}
        onEvent={vi.fn()}
      />,
    );
    expect(getByText("Start a conversation.")).toBeTruthy();
  });
});
