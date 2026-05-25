import { describe, expect, it } from "vitest";
import { handleChatMessages } from "./chatMessages";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

describe("handleChatMessages", () => {
  it("removes the failed message and resends it", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatMessages(
      {
        component: { id: "chat-history", type: "chat-history" },
        eventType: "retry",
        data: { messageId: "failed-1", value: "try again" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.updateActiveTab).toHaveBeenCalledTimes(1);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    const tab = {
      ...makeEmptyTab("default", "Tab 1"),
      messages: [
        { id: "failed-1", role: "user" as const, text: "try again" },
        { id: "ok", role: "agent" as const, text: "still here" },
      ],
    };
    expect(updater(tab).messages).toEqual([
      { id: "ok", role: "agent", text: "still here" },
    ]);
    expect(mocks.sendChat).toHaveBeenCalledWith("try again", {
      mode: "normal",
    });
  });

  it("ignores blank retry text", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatMessages(
      {
        component: { id: "chat-history", type: "chat-history" },
        eventType: "retry",
        data: { messageId: "failed-1", value: "   " },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.updateActiveTab).not.toHaveBeenCalled();
    expect(mocks.sendChat).not.toHaveBeenCalled();
  });
});
