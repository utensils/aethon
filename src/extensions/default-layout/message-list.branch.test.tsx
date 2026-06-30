// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageRow } from "./message-list";
import { ConversationTurnRow } from "./message-groups";
import type { ChatMessage } from "../../types/a2ui";
import { buildTranscriptRows } from "../../utils/transcriptRows";

afterEach(cleanup);

function row(message: ChatMessage, onEvent = vi.fn()) {
  render(
    <ChatMessageRow
      message={message}
      state={{}}
      tabId="tab-1"
      onEvent={onEvent}
    />,
  );
  return onEvent;
}

function turn(
  messages: ChatMessage[],
  onEvent = vi.fn(),
  tabId = "tab-1",
  state: Record<string, unknown> = {},
) {
  const first = buildTranscriptRows(messages, "hide", new Set()).rows[0]?.turn;
  if (!first) throw new Error("expected a transcript turn");
  render(
    <ConversationTurnRow
      turn={first}
      state={state}
      tabId={tabId}
      rowClassName="a2ui-chat-message"
      onEvent={onEvent}
      thinkingVisibility="show"
      toolCallsVisibility="hide"
      expanded={false}
      onToggle={vi.fn()}
      isLatest={false}
    />,
  );
  return onEvent;
}

describe("conversation turn rollback/fork affordance", () => {
  it("keeps rollback + fork outside individual chat bubbles", () => {
    row({ id: "1", entryId: "e1", role: "agent", text: "hello" });
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Fork this turn" })).toBeNull();
  });

  it("shows one discoverable rollback + fork action set per completed turn", () => {
    turn([
      { id: "u1", entryId: "eu1", role: "user", text: "continue" },
      { id: "a1", entryId: "ea1", role: "agent", text: "first update" },
      { id: "a2", entryId: "ea2", role: "agent", text: "final answer" },
    ]);

    expect(
      screen.getAllByRole("button", { name: "Rollback this turn" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Fork this turn" }),
    ).toHaveLength(1);
    expect(screen.getByText("Rollback")).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
    const finalAnswer = screen.getByText("final answer");
    const rollback = screen.getByRole("button", {
      name: "Rollback this turn",
    });
    const fork = screen.getByRole("button", { name: "Fork this turn" });
    expect(
      finalAnswer.compareDocumentPosition(rollback) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      finalAnswer.compareDocumentPosition(fork) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      fork.closest(".a2ui-chat-message"),
    ).toBeNull();
    expect(
      rollback.closest(".ae-turn-branch-actions"),
    ).toBe(fork.closest(".ae-turn-branch-actions"));
  });

  it("targets the latest visible branchable message in the turn", () => {
    const onEvent = turn([
      { id: "u1", entryId: "eu1", role: "user", text: "continue" },
      { id: "a1", entryId: "ea1", role: "agent", text: "first update" },
      {
        id: "a2",
        entryId: "ea2",
        role: "agent",
        text: "final answer",
        cwd: "/repo/aethon",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Fork this turn" }));
    expect(onEvent).toHaveBeenCalledWith("fork-to-tab", {
      entryId: "ea2",
      tabId: "tab-1",
      cwd: "/repo/aethon",
    });
  });

  it("uses the owning tab cwd when restored messages do not carry cwd", () => {
    const onEvent = turn(
      [
        { id: "u1", entryId: "eu1", role: "user", text: "continue" },
        { id: "a1", entryId: "ea1", role: "agent", text: "final answer" },
      ],
      vi.fn(),
      "tab-1",
      {
        tabs: [{ id: "tab-1", cwd: "/repo/restored" }],
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Fork this turn" }));
    expect(onEvent).toHaveBeenCalledWith("fork-to-tab", {
      entryId: "ea1",
      tabId: "tab-1",
      cwd: "/repo/restored",
    });
  });

  it("falls back to the user message for a user-only completed turn", () => {
    const onEvent = turn([
      { id: "u1", entryId: "eu1", role: "user", text: "continue" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Fork this turn" }));
    expect(onEvent).toHaveBeenCalledWith("fork-to-tab", {
      entryId: "eu1",
      tabId: "tab-1",
    });
  });

  it("renders post-user system output below the user prompt", () => {
    turn([
      { id: "u1", role: "user", text: "/mcp" },
      { id: "s1", role: "system", text: "## MCP servers\n- `nixos`" },
    ]);

    const user = screen.getByText("/mcp");
    const system = screen.getByText("MCP servers");

    expect(
      user.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the affordance when the turn has no branchable entry", () => {
    turn([{ id: "1", role: "agent", text: "hello" }]);
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Fork this turn" })).toBeNull();
  });

  it("hides the affordance on text-less rows such as tool-card-only turns", () => {
    turn([{ id: "tc", entryId: "e1", role: "agent" }]);
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
  });

  it("shows fork only on an assistant-only thinking turn", () => {
    turn([
      { id: "1", entryId: "e1", role: "agent", thinking: "let me reason" },
    ]);
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Fork this turn" })).toBeTruthy();
  });

  it("keeps fork available while hiding rollback for legacy running state", () => {
    turn(
      [{ id: "1", entryId: "e1", role: "agent", text: "working" }],
      vi.fn(),
      "tab-1",
      { waiting: true },
    );
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Fork this turn" })).toBeTruthy();
  });

  it("keeps fork available while hiding rollback for the owning running tab", () => {
    turn(
      [{ id: "1", entryId: "e1", role: "agent", text: "working" }],
      vi.fn(),
      "tab-1",
      { waiting: false, agentRunningTabs: { "tab-1": true } },
    );
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Fork this turn" })).toBeTruthy();
  });

  it("keeps fork available for assistant-only turns when another tab is running", () => {
    turn(
      [{ id: "1", entryId: "e1", role: "agent", text: "done" }],
      vi.fn(),
      "tab-1",
      { waiting: false, agentRunningTabs: { "tab-2": true } },
    );
    expect(
      screen.queryByRole("button", { name: "Rollback this turn" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Fork this turn" })).toBeTruthy();
  });

  it("rollback requires a second confirm click", () => {
    const onEvent = turn([
      { id: "u1", entryId: "eu1", role: "user", text: "continue" },
      { id: "a1", entryId: "ea1", role: "agent", text: "final answer" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Rollback this turn" }));
    expect(onEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm rollback"));
    expect(onEvent).toHaveBeenCalledWith("rollback-to-here", {
      entryId: "eu1",
      tabId: "tab-1",
    });
  });
});
