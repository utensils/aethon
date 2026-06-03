import { describe, expect, it } from "vitest";
import { handleSessionRolledBack } from "./sessionRolledBack";
import { buildHandlerFixture } from "./testFixtures";
import type { Tab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

const messages: ChatMessage[] = [
  { id: "1", entryId: "e1", role: "user", text: "a" },
  { id: "2", entryId: "e2", role: "agent", text: "b" },
  { id: "3", entryId: "e3", role: "user", text: "c" },
];

describe("handleSessionRolledBack", () => {
  it("truncates the tab transcript to the confirmed entry", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionRolledBack(
      { type: "session_rolled_back", tabId: "t1", entryId: "e2" },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledWith("t1", expect.any(Function));
    const updater = mocks.updateTab.mock.calls[0][1] as (t: Tab) => Tab;
    const next = updater({ id: "t1", messages, waiting: true } as Tab);
    expect(next.messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(next.waiting).toBe(false);
  });

  it("ignores a message with no entryId", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionRolledBack({ type: "session_rolled_back", tabId: "t1" }, ctx);
    expect(mocks.updateTab).not.toHaveBeenCalled();
  });
});
