import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { handleSessionForked } from "./sessionForked";
import { buildHandlerFixture } from "./testFixtures";
import { handleSessionBranch } from "../../eventRoutes/session";
import { buildRouteFixture } from "../../eventRoutes/testFixtures";

afterEach(() => vi.clearAllMocks());

describe("handleSessionForked", () => {
  it("copies the forked session file then opens the new tab", async () => {
    invoke.mockResolvedValue(undefined);
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked(
      {
        type: "session_forked",
        tabId: "t1",
        newTabId: "t2",
        sourcePath: "/s/x.jsonl",
        label: "Fork of foo",
        cwd: "/proj",
      },
      ctx,
    );
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("copy_session_file", {
        sourcePath: "/s/x.jsonl",
        destTabId: "t2",
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.newTab).toHaveBeenCalledWith("t2", "Fork of foo", {
        restoredSession: true,
        cwd: "/proj",
      }),
    );
    expect(mocks.dismissNotification).toHaveBeenCalledWith("session-fork-t1");
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      title: "Forked session",
      message: "Opened Fork of foo.",
      kind: "success",
      durationMs: 3000,
    });
  });

  it("does not open a tab when the copy fails", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked(
      {
        type: "session_forked",
        tabId: "t1",
        newTabId: "t2",
        sourcePath: "/s/x.jsonl",
        label: "Fork",
      },
      ctx,
    );
    await vi.waitFor(() => expect(mocks.pushNotification).toHaveBeenCalled());
    expect(mocks.dismissNotification).toHaveBeenCalledWith("session-fork-t1");
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fork failed",
        message: "Couldn't copy the forked session: boom",
        kind: "error",
      }),
    );
    expect(mocks.newTab).not.toHaveBeenCalled();
  });

  it("clears the fork debounce after the frontend copy succeeds", async () => {
    invoke.mockResolvedValue(undefined);
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
        sourcePath: "/s/fork.jsonl",
        label: "Fork",
      },
      ctx,
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(route.mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("clears the fork debounce after the frontend copy fails", async () => {
    invoke.mockRejectedValueOnce(new Error("copy failed"));
    const route = buildRouteFixture({ state: { activeTabId: "source-fail" } });
    const payload = {
      component: { id: "chat", type: "chat-history" },
      eventType: "fork-to-tab",
      data: { entryId: "entry-fail" },
    };
    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(route.mocks.invoke).toHaveBeenCalledTimes(1);

    const { ctx } = buildHandlerFixture();
    handleSessionForked(
      {
        type: "session_forked",
        tabId: "source-fail",
        newTabId: "fork-fail",
        sourcePath: "/s/fork-fail.jsonl",
        label: "Fork",
      },
      ctx,
    );
    await vi.waitFor(() =>
      expect(ctx.pushNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Fork failed" }),
      ),
    );

    expect(await handleSessionBranch(payload, route.ctx)).toBe(true);
    expect(route.mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("ignores a message missing newTabId or sourcePath", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked({ type: "session_forked", tabId: "t1" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.newTab).not.toHaveBeenCalled();
  });
});
