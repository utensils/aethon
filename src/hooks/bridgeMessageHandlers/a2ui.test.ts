import { describe, expect, it } from "vitest";
import { handleA2ui } from "./a2ui";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

describe("handleA2ui", () => {
  it("appends an a2ui bubble and flips waiting on done", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    const payload = { components: [{ id: "x", type: "container" }] };
    handleA2ui(
      {
        type: "a2ui",
        payload,
        id: "msg-1",
        done: true,
        tabId: "default",
      },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-1", role: "agent", a2ui: payload }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "ready" });
  });

  it("replaces a stale running terminal tool card when the final event has a sibling id", () => {
    const runningId =
      "tool-1-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const finalId =
      "tool-2-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id: runningId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: runningId,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "sleep 60",
                  startedAt: 1_000,
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id: finalId,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "sleep 60",
            startedAt: 1_000,
            endedAt: 2_000,
            isError: true,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: finalId, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id: finalId,
      role: "agent",
      a2ui: payload,
    });
  });
});
