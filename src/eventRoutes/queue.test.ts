import { describe, expect, it } from "vitest";
import { handleQueuedMessages } from "./queue";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

function fixtureWithActiveAgentTab() {
  const tab = {
    ...makeEmptyTab("tab-1", "Tab 1"),
    queuedMessages: [
      { id: "q1", content: "first" },
      { id: "q2", content: "second" },
    ],
    queueCount: 2,
  };
  return buildRouteFixture({
    state: { tabs: [tab], activeTabId: "tab-1" },
  });
}

const POPOVER = { id: "queued-messages-popover", type: "queued-messages-popover" };

describe("handleQueuedMessages", () => {
  it("forwards edit events with messageId + content to ctx.editQueuedMessage", async () => {
    const { ctx, mocks } = fixtureWithActiveAgentTab();
    const handled = await handleQueuedMessages(
      {
        component: POPOVER,
        eventType: "edit",
        data: { messageId: "q1", content: "rewritten" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.editQueuedMessage).toHaveBeenCalledWith(
      "tab-1",
      "q1",
      "rewritten",
    );
  });

  it("forwards delete to ctx.deleteQueuedMessage", async () => {
    const { ctx, mocks } = fixtureWithActiveAgentTab();
    const handled = await handleQueuedMessages(
      { component: POPOVER, eventType: "delete", data: { messageId: "q2" } },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.deleteQueuedMessage).toHaveBeenCalledWith("tab-1", "q2");
  });

  it("forwards steer to ctx.steerQueuedMessage", async () => {
    const { ctx, mocks } = fixtureWithActiveAgentTab();
    const handled = await handleQueuedMessages(
      { component: POPOVER, eventType: "steer", data: { messageId: "q1" } },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.steerQueuedMessage).toHaveBeenCalledWith("tab-1", "q1");
  });

  it("forwards clear to ctx.clearQueuedMessages", async () => {
    const { ctx, mocks } = fixtureWithActiveAgentTab();
    const handled = await handleQueuedMessages(
      { component: POPOVER, eventType: "clear" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.clearQueuedMessages).toHaveBeenCalledWith("tab-1");
  });

  it("is a no-op when the active tab is not an agent tab", async () => {
    const shellTab = makeEmptyTab("shell-1", "Shell 1", null, "shell");
    const { ctx, mocks } = buildRouteFixture({
      state: { tabs: [shellTab], activeTabId: "shell-1" },
    });
    const handled = await handleQueuedMessages(
      { component: POPOVER, eventType: "clear" },
      ctx,
    );
    expect(handled).toBe(false);
    expect(mocks.clearQueuedMessages).not.toHaveBeenCalled();
  });

  it("ignores malformed edit payloads (missing messageId)", async () => {
    const { ctx, mocks } = fixtureWithActiveAgentTab();
    const handled = await handleQueuedMessages(
      { component: POPOVER, eventType: "edit", data: { content: "x" } },
      ctx,
    );
    expect(handled).toBe(false);
    expect(mocks.editQueuedMessage).not.toHaveBeenCalled();
  });
});
