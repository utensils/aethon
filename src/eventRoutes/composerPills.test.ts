import { describe, expect, it } from "vitest";
import { handleComposerPills } from "./composerPills";
import { buildRouteFixture } from "./testFixtures";
import { makeEmptyTab } from "../types/tab";

const pillEvent = (eventType: string, data?: unknown) => ({
  component: {
    id: "composer-visibility-pills",
    type: "composer-visibility-pills",
  },
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

  it("toggles plan mode on the active agent tab", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeTabId: "t1",
        tabs: [makeEmptyTab("t1", "T1")],
      },
    });
    const handled = handleComposerPills(pillEvent("toggle-plan"), ctx);
    expect(handled).toBe(true);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(updater(makeEmptyTab("t1", "T1")).planMode).toBe(true);
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Plan mode on", kind: "success" }),
    );
  });

  it("cycles tool calls through the grouping styles from the global default", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: {
        activeTabId: "t1",
        transcriptVisibility: { toolCalls: "show" },
        tabs: [makeEmptyTab("t1", "T1")],
      },
    });
    // show → group-turn (first grouped style).
    handleComposerPills(pillEvent("cycle", { category: "toolCalls" }), ctx);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(
      updater(makeEmptyTab("t1", "T1")).visibilityOverrides.toolCalls,
    ).toBe("group-turn");
  });

  it("cycles group-block → hide and a legacy 'collapse' override resolves into the cycle", () => {
    const blockTab = {
      ...makeEmptyTab("t1", "T1"),
      visibilityOverrides: { toolCalls: "group-block" as const },
    };
    const fx = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [blockTab] },
    });
    handleComposerPills(pillEvent("cycle", { category: "toolCalls" }), fx.ctx);
    expect(
      fx.mocks.updateActiveTab.mock.calls[0][0](blockTab).visibilityOverrides
        .toolCalls,
    ).toBe("hide");

    // A legacy "collapse" override resolves to group-turn, so cycling advances
    // to group-run (not the removed tri-state "hide").
    const legacyTab = {
      ...makeEmptyTab("t2", "T2"),
      visibilityOverrides: { toolCalls: "collapse" },
    } as unknown as ReturnType<typeof makeEmptyTab>;
    const fx2 = buildRouteFixture({
      state: { activeTabId: "t2", tabs: [legacyTab] },
    });
    handleComposerPills(pillEvent("cycle", { category: "toolCalls" }), fx2.ctx);
    expect(
      fx2.mocks.updateActiveTab.mock.calls[0][0](legacyTab).visibilityOverrides
        .toolCalls,
    ).toBe("group-run");
  });

  it("jumps straight to a grouping style on set-tool-grouping", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [makeEmptyTab("t1", "T1")] },
    });
    const handled = handleComposerPills(
      pillEvent("set-tool-grouping", { mode: "group-block" }),
      ctx,
    );
    expect(handled).toBe(true);
    expect(
      mocks.updateActiveTab.mock.calls[0][0](makeEmptyTab("t1", "T1"))
        .visibilityOverrides.toolCalls,
    ).toBe("group-block");
  });

  it("ignores set-tool-grouping with a non-grouping mode", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [makeEmptyTab("t1", "T1")] },
    });
    handleComposerPills(pillEvent("set-tool-grouping", { mode: "hide" }), ctx);
    expect(mocks.updateActiveTab).not.toHaveBeenCalled();
  });

  it("clears per-tab overrides on reset-to-global", () => {
    const tab = {
      ...makeEmptyTab("t1", "T1"),
      visibilityOverrides: {
        thinking: "hide" as const,
        toolCalls: "group-run" as const,
      },
    };
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [tab] },
    });
    const handled = handleComposerPills(pillEvent("reset-to-global"), ctx);
    expect(handled).toBe(true);
    expect(
      mocks.updateActiveTab.mock.calls[0][0](tab).visibilityOverrides,
    ).toBe(undefined);
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
        transcriptVisibility: { thinking: "show", toolCalls: "group-run" },
        tabs: [tab],
      },
    });
    const handled = handleComposerPills(pillEvent("set-default"), ctx);
    expect(handled).toBe(true);
    expect(mocks.applySettingsPatch).toHaveBeenCalledWith({
      ui: { thinkingVisibility: "hide", toolCallsVisibility: "group-run" },
    });
  });

  it("toggles the per-session hard guardrail override", () => {
    const { ctx, mocks } = buildRouteFixture({
      state: { activeTabId: "t1", tabs: [makeEmptyTab("t1", "T1")] },
    });
    const handled = handleComposerPills(
      pillEvent("toggle-guardrail", { next: true }),
      ctx,
    );
    expect(handled).toBe(true);
    const updater = mocks.updateActiveTab.mock.calls[0][0];
    expect(updater(makeEmptyTab("t1", "T1")).hardEnforceProjectRoot).toBe(true);
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
