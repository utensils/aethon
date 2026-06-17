import { describe, expect, it } from "vitest";
import { handleSessionLabelChanged } from "./sessionLabelChanged";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleSessionLabelChanged", () => {
  it("updates the matching open tab label immediately", () => {
    const { ctx, applySetState } = buildHandlerFixture({
      state: {
        tabs: [
          makeEmptyTab("tab-1", "Tab 1"),
          makeEmptyTab("tab-2", "Tab 2"),
        ],
      },
    });

    handleSessionLabelChanged(
      {
        type: "session_label_changed",
        tabId: "tab-1",
        label: "Prompt polish",
      },
      ctx,
    );

    const next = applySetState();
    expect((next.tabs as { id: string; label: string }[])[0]).toMatchObject({
      id: "tab-1",
      label: "Prompt polish",
    });
    expect((next.tabs as { id: string; label: string }[])[1]).toMatchObject({
      id: "tab-2",
      label: "Tab 2",
    });
  });

  it("updates discovered-session metadata when the bridge includes it", () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.allDiscoveredSessionsRef.current = [
      { tabId: "tab-1", lastModified: 1, customLabel: "Old" },
    ];

    handleSessionLabelChanged(
      {
        type: "session_label_changed",
        tabId: "tab-1",
        label: "Prompt polish",
        session: {
          tabId: "tab-1",
          lastModified: 42,
          cwd: "/repo/a",
          customLabel: "Prompt polish",
        },
      },
      ctx,
    );

    expect(ctx.allDiscoveredSessionsRef.current).toEqual([
      {
        tabId: "tab-1",
        lastModified: 42,
        cwd: "/repo/a",
        customLabel: "Prompt polish",
      },
    ]);
    expect(mocks.syncRecentSessionsToState).toHaveBeenCalledOnce();
  });
});
