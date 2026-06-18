import { describe, expect, it } from "vitest";
import { handleChatInput } from "./chatInput";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

describe("handleChatInput", () => {
  it("submit forwards value to sendChat as a normal message", async () => {
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
    expect(mocks.sendChat).toHaveBeenCalledWith("hello", { mode: "normal" });
  });

  it("submit forwards command-enter steering mode", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "submit",
        data: { value: "look now", mode: "steer" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.sendChat).toHaveBeenCalledWith("look now", { mode: "steer" });
  });

  it("mode route toggles plan mode on the active agent tab", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "mode:toggle-plan",
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.updateActiveTab).toHaveBeenCalledTimes(1);
    const updater = mocks.updateActiveTab.mock.calls[0][0] as Parameters<
      typeof ctx.updateActiveTab
    >[0];
    expect(updater(makeEmptyTab("tab-1", "Tab 1")).planMode).toBe(true);
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Plan mode on", kind: "success" }),
    );
  });

  it("empty command-enter promotes the only queued message to steering", async () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      queuedMessages: [{ id: "q1", content: "after this" }],
      queueCount: 1,
    };
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });

    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "submit",
        data: { value: "", mode: "steer" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.steerQueuedMessage).toHaveBeenCalledWith("tab-1", "q1");
    expect(mocks.sendChat).not.toHaveBeenCalled();
  });

  it("empty command-enter promotes the newest queued message to steering", async () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      queuedMessages: [
        { id: "q1", content: "first queued" },
        { id: "q2", content: "bottom-most queued" },
      ],
      queueCount: 2,
    };
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });

    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "submit",
        data: { value: "   ", mode: "steer" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.steerQueuedMessage).toHaveBeenCalledWith("tab-1", "q2");
    expect(mocks.sendChat).not.toHaveBeenCalled();
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

  it("voice setup opens settings focused on the voice section", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "voice:setup",
        data: { providerId: "voice-distil-whisper" },
      },
      ctx,
    );

    expect(handled).toBe(true);
    expect(mocks.setState).toHaveBeenCalledTimes(1);
    expect(ctx.stateRef.current.settings).toEqual({
      open: true,
      pending: null,
      focusSection: "voice",
      focusProviderId: "voice-distil-whisper",
    });
  });

  it("voice:auto-listen live-applies and persists the toggle", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "voice:auto-listen",
        data: { value: true },
      },
      ctx,
    );

    expect(handled).toBe(true);
    // Live: the running conversation reads /voice/conversationContinuous.
    expect(
      (ctx.stateRef.current.voice as { conversationContinuous?: boolean })
        .conversationContinuous,
    ).toBe(true);
    // Persisted under the same key the Settings panel writes.
    expect(mocks.applySettingsPatch).toHaveBeenCalledWith({
      voice: { conversationContinuous: true },
    });
  });

  it("voice:auto-listen coerces a non-true value to off", async () => {
    const { ctx, mocks } = buildRouteFixture();
    await handleChatInput(
      {
        component: { id: "chat-input" },
        eventType: "voice:auto-listen",
        data: { value: false },
      },
      ctx,
    );
    expect(
      (ctx.stateRef.current.voice as { conversationContinuous?: boolean })
        .conversationContinuous,
    ).toBe(false);
    expect(mocks.applySettingsPatch).toHaveBeenCalledWith({
      voice: { conversationContinuous: false },
    });
  });

  // Wrong-id rejection is no longer the handler's responsibility — the
  // route table dispatches by `type:chat-input`, so a non-chat-input
  // event simply never reaches this handler. See index.test.ts for the
  // type-keyed routing contract.
});
