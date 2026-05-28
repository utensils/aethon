import { describe, expect, it } from "vitest";
import {
  NO_PROJECT_KEY,
  OVERVIEW_TAB_ID,
  deriveTabActiveFlags,
  isOverviewActive,
  makeEmptyTab,
  projectBucketKey,
} from "./tab";

describe("projectBucketKey", () => {
  it("returns the sentinel for null", () => {
    expect(projectBucketKey(null)).toBe(NO_PROJECT_KEY);
  });
  it("returns the sentinel for undefined", () => {
    expect(projectBucketKey(undefined)).toBe(NO_PROJECT_KEY);
  });
  it("returns the project id when present", () => {
    expect(projectBucketKey("proj-123")).toBe("proj-123");
  });
  it("does not collide with a UUID-shaped id", () => {
    const uuid = "abcdef01-2345-6789-abcd-ef0123456789";
    expect(projectBucketKey(uuid)).not.toBe(NO_PROJECT_KEY);
  });
});

describe("makeEmptyTab", () => {
  it("creates an agent tab by default", () => {
    const tab = makeEmptyTab("t1", "Tab 1");
    expect(tab.id).toBe("t1");
    expect(tab.label).toBe("Tab 1");
    expect(tab.kind).toBe("agent");
    expect(tab.projectId).toBeNull();
    expect(tab.shell).toBeUndefined();
  });

  it("seeds zero/empty values for chat fields", () => {
    const tab = makeEmptyTab("t1", "Tab 1");
    expect(tab.messages).toEqual([]);
    expect(tab.draft).toBe("");
    expect(tab.waiting).toBe(false);
    expect(tab.queueCount).toBe(0);
    expect(tab.canvas).toBeNull();
    expect(tab.model).toBe("");
    expect(tab.terminalBuffer).toBe("");
  });

  it("accepts an explicit projectId", () => {
    const tab = makeEmptyTab("t1", "Tab 1", "proj-x");
    expect(tab.projectId).toBe("proj-x");
  });

  it("accepts an explicit kind", () => {
    const tab = makeEmptyTab("t1", "Tab 1", null, "shell");
    expect(tab.kind).toBe("shell");
    // shell metadata is set by newShellTab, not makeEmptyTab — the field
    // stays undefined here so callers know to populate it.
    expect(tab.shell).toBeUndefined();
  });

  it("does not share array references between tabs", () => {
    const a = makeEmptyTab("a", "A");
    const b = makeEmptyTab("b", "B");
    a.messages.push({ id: "m", role: "user", text: "hi" });
    expect(b.messages).toEqual([]);
  });
});

describe("deriveTabActiveFlags", () => {
  it("returns both false when there are no tabs", () => {
    expect(deriveTabActiveFlags([], undefined)).toEqual({
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    });
  });

  it("flags agent active for an agent tab", () => {
    const a = makeEmptyTab("a", "A");
    expect(deriveTabActiveFlags([a], "a")).toEqual({
      agentTabActive: true,
      shellTabActive: false,
      editorTabActive: false,
    });
  });

  it("flags shell active for a shell tab", () => {
    const s = makeEmptyTab("s", "Shell", null, "shell");
    expect(deriveTabActiveFlags([s], "s")).toEqual({
      agentTabActive: false,
      shellTabActive: true,
      editorTabActive: false,
    });
  });

  it("flags editor active for an editor tab", () => {
    const e = makeEmptyTab("e", "App.tsx", null, "editor");
    expect(deriveTabActiveFlags([e], "e")).toEqual({
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: true,
    });
  });

  it("returns all-false when activeTabId points at a missing tab", () => {
    // Stale-persisted-id case: tabs exist but the active id doesn't
    // match any of them. Returning all-false surfaces the overview
    // instead of a phantom session view that has no real backing tab.
    const a = makeEmptyTab("a", "A");
    expect(deriveTabActiveFlags([a], "missing")).toEqual({
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    });
  });

  it("returns all-false for the overview sentinel", () => {
    const a = makeEmptyTab("a", "A");
    expect(deriveTabActiveFlags([a], OVERVIEW_TAB_ID)).toEqual({
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    });
  });

  it("returns all-false when activeTabId is undefined even with tabs present", () => {
    const a = makeEmptyTab("a", "A");
    expect(deriveTabActiveFlags([a], undefined)).toEqual({
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    });
  });

  it("recomputes synchronously after a tabs mutation", () => {
    // Regression: useTabs used to mirror these flags via a useEffect
    // that read stateRef.current — which lags state by one render. A
    // newTab() following a project-bucket switch left agentTabActive
    // at false, hiding the chat-input on a fresh tab. Deriving the
    // flags here from (tabs, activeTabId) makes them synchronous.
    const before = deriveTabActiveFlags([], undefined);
    expect(before.agentTabActive).toBe(false);
    const a = makeEmptyTab("a", "A");
    const after = deriveTabActiveFlags([a], "a");
    expect(after.agentTabActive).toBe(true);
  });
});

describe("isOverviewActive", () => {
  it("treats undefined as overview-active", () => {
    expect(isOverviewActive(undefined)).toBe(true);
  });
  it("treats empty string as overview-active", () => {
    expect(isOverviewActive("")).toBe(true);
  });
  it("treats the sentinel as overview-active", () => {
    expect(isOverviewActive(OVERVIEW_TAB_ID)).toBe(true);
  });
  it("treats a real tab id as not overview-active", () => {
    expect(isOverviewActive("real-tab-id")).toBe(false);
  });
});
