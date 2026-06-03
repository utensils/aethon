import { describe, expect, it } from "vitest";
import { handleEntryIds } from "./entryIds";
import { buildHandlerFixture } from "./testFixtures";
import type { Tab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

function tab(messages: ChatMessage[]): Tab {
  return { id: "t1", messages } as Tab;
}

function applyUpdater(
  entries: { entryId: string; role: "user" | "agent" }[],
  messages: ChatMessage[],
): { result: Tab; called: boolean } {
  const { ctx, mocks } = buildHandlerFixture();
  handleEntryIds({ type: "entry_ids", tabId: "t1", entries }, ctx);
  if (mocks.updateTab.mock.calls.length === 0) {
    return { result: tab(messages), called: false };
  }
  const updater = mocks.updateTab.mock.calls[0][1] as (t: Tab) => Tab;
  return { result: updater(tab(messages)), called: true };
}

const a2uiRow: ChatMessage = {
  id: "tc",
  role: "agent",
  a2ui: { components: [{ id: "tool-1", type: "tool-card" }] },
};

describe("handleEntryIds", () => {
  it("assigns entry ids positionally to user/agent text rows", () => {
    const messages: ChatMessage[] = [
      { id: "u", role: "user", text: "hi" },
      { id: "a", role: "agent", text: "hello" },
    ];
    const { result } = applyUpdater(
      [
        { entryId: "E_u", role: "user" },
        { entryId: "E_a", role: "agent" },
      ],
      messages,
    );
    expect(result.messages.map((m) => m.entryId)).toEqual(["E_u", "E_a"]);
  });

  it("skips tool-card rows and a multi-segment assistant turn aligns", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "do it" },
      { id: "a1", role: "agent", text: "let me check" },
      a2uiRow, // tool card — no text, skipped
      { id: "a2", role: "agent", text: "found a bug" },
      { id: "u2", role: "user", text: "fix it" },
      { id: "a3", role: "agent", text: "fixed" },
    ];
    const { result } = applyUpdater(
      [
        { entryId: "E_u1", role: "user" },
        { entryId: "E_a1", role: "agent" },
        { entryId: "E_u2", role: "user" },
        { entryId: "E_a2", role: "agent" },
      ],
      messages,
    );
    expect(result.messages.map((m) => m.entryId)).toEqual([
      "E_u1",
      "E_a1",
      undefined, // tool card
      undefined, // second agent segment of the first turn
      "E_u2",
      "E_a2",
    ]);
  });

  it("does nothing when there are no entries", () => {
    const { called } = applyUpdater(
      [],
      [{ id: "u", role: "user", text: "hi" }],
    );
    expect(called).toBe(false);
  });

  it("returns the same tab when nothing changes", () => {
    const messages: ChatMessage[] = [
      { id: "u", role: "user", text: "hi", entryId: "E_u" },
    ];
    const { ctx, mocks } = buildHandlerFixture();
    handleEntryIds(
      {
        type: "entry_ids",
        tabId: "t1",
        entries: [{ entryId: "E_u", role: "user" }],
      },
      ctx,
    );
    const updater = mocks.updateTab.mock.calls[0][1] as (t: Tab) => Tab;
    const input = tab(messages);
    expect(updater(input)).toBe(input);
  });
});
