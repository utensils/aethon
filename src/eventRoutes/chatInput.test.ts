import { describe, expect, it } from "vitest";
import { handleChatInput } from "./chatInput";
import { buildRouteFixture } from "./testFixtures";

describe("handleChatInput", () => {
  it("submit forwards value to sendChat", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "submit",
        data: { value: "hello" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sendChat).toHaveBeenCalledWith("hello");
  });

  it("change persists draft into the active tab record", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "change",
        data: { value: "draft text" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.updateActiveTab).toHaveBeenCalledTimes(1);
  });

  it("cancel maps to stopPrompt", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      { component: { id: "chat-input" }, eventType: "cancel" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.stopPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns false for non-chat-input components", async () => {
    const { ctx } = buildRouteFixture();
    const handled = await handleChatInput(
      { component: { id: "sidebar" }, eventType: "submit" },
      ctx,
    );
    expect(handled).toBe(false);
  });
});
