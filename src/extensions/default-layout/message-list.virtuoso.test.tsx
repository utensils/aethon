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

  // A transcript with two completed turns, each using multiple tools, plus a
  // final live-ish turn. Exercises every grouped rendering path.
  function toolTranscript() {
    return [
      { id: "u1", role: "user", text: "do the thing" },
      { id: "a1", role: "agent", text: "reading files" },
      {
        id: "t1",
        role: "agent",
        a2ui: {
          components: [
            { id: "c1", type: "tool-card", props: { title: "read", startedAt: 1, endedAt: 2 } },
          ],
        },
      },
      {
        id: "t2",
        role: "agent",
        a2ui: {
          components: [
            { id: "c2", type: "tool-card", props: { title: "bash", startedAt: 1, endedAt: 2 } },
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
            { id: "c3", type: "tool-card", props: { title: "edit", startedAt: 1, endedAt: 2 } },
          ],
        },
      },
    ];
  }

  function renderToolChat(mode: string) {
    return render(
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{
          messages: toolTranscript(),
          transcriptVisibility: { toolCalls: mode },
        }}
        onEvent={vi.fn()}
      />,
    );
  }

  // Real Virtuoso virtualizes (no row mounts in jsdom), so this only guards
  // that every grouped mode wires through Virtuoso without crashing
  // computeItemKey. Rendered-content assertions live in chat.test.tsx, which
  // mocks Virtuoso and actually mounts the rows.
  it("mounts every tool-call visibility mode without crashing", () => {
    for (const mode of ["show", "group-run", "group-turn", "group-block", "hide"]) {
      expect(() => renderToolChat(mode)).not.toThrow();
    }
  });

  it("cycles visibility modes on a mounted transcript without crashing", () => {
    const messages = toolTranscript();
    const view = (mode: string) => (
      <ChatHistory
        component={{
          id: "chat-history",
          type: "chat-history",
          props: { messages: { $ref: "/messages" } },
        }}
        state={{ messages, transcriptVisibility: { toolCalls: mode } }}
        onEvent={vi.fn()}
      />
    );
    const { rerender } = render(view("show"));
    // Cycling exercises rangeChanged / groupKey / the anchor-lookup effect.
    expect(() => {
      for (const mode of ["group-run", "group-turn", "group-block", "hide", "show"]) {
        rerender(view(mode));
      }
    }).not.toThrow();
  });

  it("remounts per tab id (key) and restores state without crashing", () => {
    const msgs = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${prefix}${i}`,
        role: i % 2 === 0 ? "user" : "agent",
        text: `${prefix} message ${i}`,
      }));
    const view = (tabId: string, messages: ReturnType<typeof msgs>) => (
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
    const { rerender } = render(view("a", msgs("a", 20)));
    // Switching tab id changes the inner Virtuoso key → unmount (getState
    // snapshot capture) + remount (restoreStateFrom). Must not throw.
    expect(() => {
      rerender(view("b", msgs("b", 5)));
      rerender(view("a", msgs("a", 20)));
    }).not.toThrow();
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
