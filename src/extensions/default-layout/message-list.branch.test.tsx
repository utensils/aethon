// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageRow } from "./message-list";
import type { ChatMessage } from "../../types/a2ui";

afterEach(cleanup);

function row(
  message: ChatMessage,
  onEvent = vi.fn(),
  tabId = "tab-1",
  state: Record<string, unknown> = {},
) {
  render(
    <ChatMessageRow
      message={message}
      state={state}
      tabId={tabId}
      onEvent={onEvent}
    />,
  );
  return onEvent;
}

describe("ChatMessageRow rollback/fork affordance", () => {
  it("shows quiet rollback + fork icon actions on a user/agent row that has an entry id", () => {
    row({ id: "1", entryId: "e1", role: "agent", text: "hello" });
    expect(
      screen.getByRole("button", { name: "Rollback to this message" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Fork from this message" }),
    ).toBeTruthy();
    expect(screen.queryByText("↶ Rollback")).toBeNull();
    expect(screen.queryByText("⑂ Fork")).toBeNull();
  });

  it("hides the affordance when there is no entry id", () => {
    row({ id: "1", role: "agent", text: "hello" });
    expect(
      screen.queryByRole("button", { name: "Rollback to this message" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fork from this message" }),
    ).toBeNull();
  });

  it("hides the affordance on text-less rows (e.g. tool cards)", () => {
    // Tool-card rows carry an a2ui payload but no text; the gate keys off
    // text, so the affordance never appears on them.
    row({ id: "tc", entryId: "e1", role: "agent" });
    expect(
      screen.queryByRole("button", { name: "Rollback to this message" }),
    ).toBeNull();
  });

  it("hides the affordance on system rows", () => {
    row({ id: "s", entryId: "e1", role: "system", text: "Context compacted" });
    expect(
      screen.queryByRole("button", { name: "Rollback to this message" }),
    ).toBeNull();
  });

  it("shows the affordance on a thinking-only turn", () => {
    row({ id: "1", entryId: "e1", role: "agent", thinking: "let me reason" });
    expect(
      screen.getByRole("button", { name: "Rollback to this message" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Fork from this message" }),
    ).toBeTruthy();
  });

  it("hides the affordance while the session is still running", () => {
    row(
      { id: "1", entryId: "e1", role: "agent", text: "working" },
      vi.fn(),
      "tab-1",
      { waiting: true },
    );
    expect(
      screen.queryByRole("button", { name: "Rollback to this message" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fork from this message" }),
    ).toBeNull();
  });

  it("hides the affordance while the owning tab is still running", () => {
    row(
      { id: "1", entryId: "e1", role: "agent", text: "working" },
      vi.fn(),
      "tab-1",
      { waiting: false, agentRunningTabs: { "tab-1": true } },
    );
    expect(
      screen.queryByRole("button", { name: "Rollback to this message" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fork from this message" }),
    ).toBeNull();
  });

  it("keeps affordances available when another tab is running", () => {
    row(
      { id: "1", entryId: "e1", role: "agent", text: "done" },
      vi.fn(),
      "tab-1",
      { waiting: false, agentRunningTabs: { "tab-2": true } },
    );
    expect(
      screen.getByRole("button", { name: "Rollback to this message" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Fork from this message" }),
    ).toBeTruthy();
  });

  it("fork fires fork-to-tab immediately", () => {
    const onEvent = row({ id: "1", entryId: "e1", role: "user", text: "hi" });
    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this message" }),
    );
    expect(onEvent).toHaveBeenCalledWith("fork-to-tab", {
      entryId: "e1",
      tabId: "tab-1",
    });
  });

  it("rollback requires a second confirm click", () => {
    const onEvent = row({ id: "1", entryId: "e1", role: "user", text: "hi" });
    fireEvent.click(
      screen.getByRole("button", { name: "Rollback to this message" }),
    );
    // First click only arms the confirm — no event yet.
    expect(onEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm rollback"));
    expect(onEvent).toHaveBeenCalledWith("rollback-to-here", {
      entryId: "e1",
      tabId: "tab-1",
    });
  });
});
