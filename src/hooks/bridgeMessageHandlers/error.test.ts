import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "./error";
import { handleSessionHistory } from "./sessionHistory";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

describe("handleError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends an error message, clears waiting, sets error status when active", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    ctx.activeResponseIdRef.current = "msg-1";
    handleError({ type: "error", message: "boom", tabId: "default" }, ctx);
    expect(ctx.activeResponseIdRef.current).toBeNull();
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "agent", text: "Error: boom" }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "error" });
  });

  it("surfaces branch action failures as notifications", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1" },
    });
    handleError(
      {
        type: "error",
        message: "fork_session: unknown entry abc123",
        tabId: "tab-1",
      },
      ctx,
    );

    expect(mocks.dismissNotification).toHaveBeenCalledWith(
      "session-fork-tab-1",
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      title: "Fork failed",
      message: "unknown entry abc123",
      kind: "error",
      durationMs: 6000,
    });
  });

  it("keeps API errors chronological when restored history rehydrates later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T10:00:02.000Z"));

    const errorFixture = buildHandlerFixture({
      state: { activeTabId: "tab-1" },
    });
    handleError(
      {
        type: "error",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
        tabId: "tab-1",
      },
      errorFixture.ctx,
    );
    const localError = errorFixture.mocks.appendMessage.mock
      .calls[0][0] as ChatMessage;

    const historyFixture = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "before-error",
            role: "agent",
            text: "Tool output before the API error",
            createdAt: Date.parse("2026-06-22T10:00:01.000Z"),
          },
          {
            id: "after-error",
            role: "agent",
            text: "Later restored response",
            createdAt: Date.parse("2026-06-22T10:00:03.000Z"),
          },
        ],
      },
      historyFixture.ctx,
    );
    const [, updater] = historyFixture.mocks.updateTab.mock.calls[0];
    const out = updater({
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [localError],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "before-error",
      localError.id,
      "after-error",
    ]);
    expect(localError).toMatchObject({
      role: "agent",
      text: expect.stringContaining("Your credit balance is too low"),
      createdAt: Date.parse("2026-06-22T10:00:02.000Z"),
    });
  });
});
