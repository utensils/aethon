import { describe, expect, it } from "vitest";
import { defaultLayoutExtension } from "../../extensions/default-layout";
import { EMPTY_AUTH_PROFILES } from "../../auth-profiles";
import { makeEmptyTab } from "../../types/tab";
import { reduceReadyState } from "./readyState";

const baseInput = {
  authProfiles: EMPTY_AUTH_PROFILES,
  baseLayout: { components: [] },
  bridgeTabs: [],
  extState: {},
  fallbackModel: "claude",
  models: [{ id: "claude", label: "Claude", provider: "anthropic" }],
  recentSessions: [],
  shouldNormalizeWorkstationLayout: false,
  tabReplay: {},
  willPruneKeys: [],
};

describe("reduceReadyState", () => {
  it("applies layout defaults, prunes stale extension paths, and overlays live extension state", () => {
    const next = reduceReadyState(
      {
        activeTabId: "default",
        old: "stale",
        keep: "local",
        tabs: [{ id: "default", model: "" }],
        sidebar: {},
      },
      {
        ...baseInput,
        baseLayout: {
          components: [],
          state: {
            keep: "default",
            layout: { areas: ["sidebar canvas"], columns: "1fr" },
          },
        },
        extState: { keep: "extension", extensionOnly: true },
        willPruneKeys: ["/old"],
      },
    );

    expect(next).not.toHaveProperty("old");
    expect(next.keep).toBe("extension");
    expect(next.extensionOnly).toBe(true);
    expect(next.layout).toEqual({ areas: ["sidebar canvas"], columns: "1fr" });
  });

  it("reconciles only local tabs and replays missing per-tab mirror fields", () => {
    const local = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      model: "",
      messages: [{ id: "local", role: "user", content: "keep me" }],
      canvas: null,
    };
    const next = reduceReadyState(
      {
        activeTabId: "tab-1",
        tabs: [local],
        sidebar: {},
      },
      {
        ...baseInput,
        bridgeTabs: [
          {
            id: "tab-1",
            model: "bridge-model",
            cwd: "/repo/a",
            thinkingLevel: "high",
          },
          {
            id: "bridge-only",
            model: "must-not-appear",
            cwd: "/repo/b",
          },
        ],
        fallbackModel: "fallback",
        tabReplay: {
          "tab-1": {
            messages: [{ id: "replay", role: "assistant", content: "skip" }],
            canvas: { components: [{ id: "card", type: "card" }] },
          },
        },
      },
    );

    const tabs = next.tabs as typeof local[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: "tab-1",
      model: "fallback",
      cwd: "/repo/a",
      thinkingLevel: "high",
      canvas: { components: [{ id: "card", type: "card" }] },
    });
    expect(tabs[0].messages).toEqual([
      { id: "local", role: "user", content: "keep me" },
    ]);
    expect(next.messages).toEqual(tabs[0].messages);
    expect(next.canvas).toEqual(tabs[0].canvas);
  });

  it("treats an empty default thinking level as unset", () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      model: "claude",
      thinkingLevel: "high",
    };

    const next = reduceReadyState(
      {
        activeTabId: "tab-1",
        defaultThinkingLevel: "",
        tabs: [tab],
        sidebar: {},
      },
      baseInput,
    );

    expect(next.defaultThinkingLevel).toBe("high");
    expect(next.thinkingLevel).toBe("high");
  });

  it("normalizes stale workstation layout rows through the pure reducer", () => {
    const next = reduceReadyState(
      {
        activeTabId: "default",
        tabs: [{ id: "default" }],
        layout: {
          columns: "220px minmax(0,1fr) 360px",
          rows: "38px minmax(0,1fr) 0px auto auto",
          areas: [
            "sidebar header files-sidebar",
            "sidebar canvas files-sidebar",
            "sidebar terminal files-sidebar",
            "sidebar composer files-sidebar",
            "status status status",
          ],
        },
        sidebar: {},
      },
      {
        ...baseInput,
        baseLayout: defaultLayoutExtension.layout!,
        shouldNormalizeWorkstationLayout: true,
      },
    );

    expect(next.layout).toMatchObject({
      rows: "38px 38px minmax(0,1fr) 0px auto auto",
      areas: [
        "sidebar header files-sidebar",
        "sidebar tabs files-sidebar",
        "sidebar canvas files-sidebar",
        "sidebar terminal files-sidebar",
        "sidebar composer files-sidebar",
        "status status status",
      ],
    });
  });
});
