import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { handleSessionForked } from "./sessionForked";
import { buildHandlerFixture } from "./testFixtures";

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
    expect(mocks.newTab).not.toHaveBeenCalled();
  });

  it("ignores a message missing newTabId or sourcePath", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionForked({ type: "session_forked", tabId: "t1" }, ctx);
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.newTab).not.toHaveBeenCalled();
  });
});
