import { describe, expect, it } from "vitest";
import { handleComposerPills } from "./composerPills";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

const pillEvent = (eventType: string, data?: unknown) => ({
  component: { id: "composer-visibility-pills", type: "composer-visibility-pills" },
  eventType,
  data,
});

describe("handleComposerPills", () => {
  it("ignores events from other components", () => {
    const { ctx } = buildRouteFixture();
    expect(
      handleComposerPills(
        { component: { id: "x", type: "chat-input" }, eventType: "cycle" },
        ctx,
      ),
    ).toBe(false);
  });

  it("cycles the active tab thinking override show → collapse off the global default", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeTabId: "t1",
        transcriptVisibility: { thinking: "show", toolCalls: "show" },
        tabs: [makeEmptyTab("t1", "T1")],
      },
    });
    const handled = handleComposerPills(
      pillEvent("cycle", { category: "thinking" }),
      ctx,
    );
    expect(handled).toBe(true);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(updater(makeEmptyTab("t1", "T1")).visibilityOverrides).toEqual({
      thinking: "collapse",
    });
  });

  it("cycles off the per-tab override when present (collapse → hide)", () => {
    const tab = {
      ...makeEmptyTab("t1", "T1"),
      visibilityOverrides: { toolCalls: "collapse" as const },
    };
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [tab] },
    });
    handleComposerPills(pillEvent("cycle", { category: "toolCalls" }), ctx);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(updater(tab).visibilityOverrides.toolCalls).toBe("hide");
  });

  it("wraps hide back to show", () => {
    const tab = {
      ...makeEmptyTab("t1", "T1"),
      visibilityOverrides: { thinking: "hide" as const },
    };
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [tab] },
    });
    handleComposerPills(pillEvent("cycle", { category: "thinking" }), ctx);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(updater(tab).visibilityOverrides.thinking).toBe("show");
  });

  it("promotes effective visibility to the global config on set-default", () => {
    const tab = {
      ...makeEmptyTab("t1", "T1"),
      visibilityOverrides: { thinking: "hide" as const },
    };
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeTabId: "t1",
        transcriptVisibility: { thinking: "show", toolCalls: "collapse" },
        tabs: [tab],
      },
    });
    const handled = handleComposerPills(pillEvent("set-default"), ctx);
    expect(handled).toBe(true);
    expect(mocks.applySettingsPatch).toHaveBeenCalledWith({
      ui: { thinkingVisibility: "hide", toolCallsVisibility: "collapse" },
    });
  });

  it("ignores a cycle with an unknown category but marks it handled", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [makeEmptyTab("t1", "T1")] },
    });
    const handled = handleComposerPills(
      pillEvent("cycle", { category: "nope" }),
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.updateActiveTab).not.toHaveBeenCalled();
  });
});
