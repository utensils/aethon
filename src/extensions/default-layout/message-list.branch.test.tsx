// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageRow } from "./message-list";
import type { ChatMessage } from "../../types/a2ui";

afterEach(cleanup);

function row(message: ChatMessage, onEvent = vi.fn()) {
  render(<ChatMessageRow message={message} state={{}} onEvent={onEvent} />);
  return onEvent;
}

describe("ChatMessageRow rollback/fork affordance", () => {
  it("shows Rollback + Fork on a user/agent row that has an entry id", () => {
    row({ id: "1", entryId: "e1", role: "agent", text: "hello" });
    expect(screen.getByText("↶ Rollback")).toBeTruthy();
    expect(screen.getByText("⑂ Fork")).toBeTruthy();
  });

  it("hides the affordance when there is no entry id", () => {
    row({ id: "1", role: "agent", text: "hello" });
    expect(screen.queryByText("↶ Rollback")).toBeNull();
    expect(screen.queryByText("⑂ Fork")).toBeNull();
  });

  it("hides the affordance on text-less rows (e.g. tool cards)", () => {
    // Tool-card rows carry an a2ui payload but no text; the gate keys off
    // text, so the affordance never appears on them.
    row({ id: "tc", entryId: "e1", role: "agent" });
    expect(screen.queryByText("↶ Rollback")).toBeNull();
  });

  it("hides the affordance on system rows", () => {
    row({ id: "s", entryId: "e1", role: "system", text: "Context compacted" });
    expect(screen.queryByText("↶ Rollback")).toBeNull();
  });

  it("shows the affordance on a thinking-only turn", () => {
    row({ id: "1", entryId: "e1", role: "agent", thinking: "let me reason" });
    expect(screen.getByText("↶ Rollback")).toBeTruthy();
    expect(screen.getByText("⑂ Fork")).toBeTruthy();
  });

  it("fork fires fork-to-tab immediately", () => {
    const onEvent = row({ id: "1", entryId: "e1", role: "user", text: "hi" });
    fireEvent.click(screen.getByText("⑂ Fork"));
    expect(onEvent).toHaveBeenCalledWith("fork-to-tab", { entryId: "e1" });
  });

  it("rollback requires a second confirm click", () => {
    const onEvent = row({ id: "1", entryId: "e1", role: "user", text: "hi" });
    fireEvent.click(screen.getByText("↶ Rollback"));
    // First click only arms the confirm — no event yet.
    expect(onEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm rollback"));
    expect(onEvent).toHaveBeenCalledWith("rollback-to-here", { entryId: "e1" });
  });
});
