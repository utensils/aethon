import { describe, expect, it } from "vitest";
import { handleSessionBranch } from "./session";
import { buildRouteFixture } from "./testFixtures";
import type { Tab } from "../types/tab";
import type { ChatMessage } from "../types/a2ui";

const event = (eventType: string, data: Record<string, unknown>) => ({
  component: { id: "chat", type: "chat-history" },
  eventType,
  data,
});

describe("handleSessionBranch", () => {
  it("rollback-to-here truncates optimistically and asks the bridge to branch", async () => {
    const { ctx, mocks } = buildRouteFixture({ state: { activeTabId: "t1" } });
    const handled = await handleSessionBranch(
      event("rollback-to-here", { entryId: "e2" }),
      ctx,
    );
    expect(handled).toBe(true);

    // Optimistic truncate: apply the captured updater to a sample tab.
    const updater = mocks.updateActiveTab.mock.calls[0][0] as (t: Tab) => Tab;
    const messages: ChatMessage[] = [
      { id: "1", entryId: "e1", role: "user", text: "a" },
      { id: "2", entryId: "e2", role: "agent", text: "b" },
      { id: "3", entryId: "e3", role: "user", text: "c" },
    ];
    const next = updater({ id: "t1", messages, waiting: true } as Tab);
    expect(next.messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(next.waiting).toBe(false);

    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "rollback_session",
        tabId: "t1",
        entryId: "e2",
      }),
    });
  });

  it("fork-to-tab asks the bridge to fork", async () => {
    const { ctx, mocks } = buildRouteFixture({ state: { activeTabId: "t1" } });
    const handled = await handleSessionBranch(
      event("fork-to-tab", { entryId: "e2" }),
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({
        type: "fork_session",
        tabId: "t1",
        entryId: "e2",
      }),
    });
  });

  it("ignores unrelated events and missing entryId", async () => {
    const { ctx } = buildRouteFixture({ state: { activeTabId: "t1" } });
    expect(await handleSessionBranch(event("retry", {}), ctx)).toBe(false);
    expect(await handleSessionBranch(event("rollback-to-here", {}), ctx)).toBe(
      false,
    );
  });
});
