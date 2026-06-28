import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSessionForked } from "./sessionForked";
import { buildHandlerFixture } from "./testFixtures";
import { handleSessionBranch } from "../../eventRoutes/session";
import { buildRouteFixture } from "../../eventRoutes/testFixtures";

afterEach(() => vi.clearAllMocks());

describe("handleSessionForked", () => {
  it("opens the new tab from SQLite state", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked(
      {
        type: "session_forked",
        tabId: "t1",
        newTabId: "t2",
        label: "Fork of foo",
        cwd: "/proj",
      },
      ctx,
    );
    expect(mocks.newTab).toHaveBeenCalledWith("t2", "Fork of foo", {
      restoredSession: true,
      cwd: "/proj",
    });
    expect(mocks.dismissNotification).toHaveBeenCalledWith("session-fork-t1");
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      title: "Forked session",
      message: "Opened Fork of foo.",
      kind: "success",
      durationMs: 3000,
    });
  });

  it("clears the fork debounce after the fork event arrives", async () => {
    const route = buildRouteFixture({ state: { activeTabId: "source-tab" } });
    const payload = {
      component: { id: "chat", type: "chat-history" },
      eventType: "fork-to-tab",
      data: { entryId: "entry-1" },
    };
    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(route.mocks.invoke).toHaveBeenCalledTimes(1);

    const { ctx } = buildHandlerFixture();
    handleSessionForked(
      {
        type: "session_forked",
        tabId: "source-tab",
        newTabId: "fork-tab",
        label: "Fork",
      },
      ctx,
    );

    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(route.mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("ignores a message missing newTabId", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked({ type: "session_forked", tabId: "t1" }, ctx);
    expect(mocks.newTab).not.toHaveBeenCalled();
  });
});
