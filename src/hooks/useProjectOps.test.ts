import { describe, expect, it } from "vitest";
import { NO_PROJECT_KEY, type Tab } from "../types/tab";
import {
  nonEmptyProjectTabs,
  projectIdFromBucketKey,
  tabsForProjectBucket,
} from "./useProjectOps";

describe("projectIdFromBucketKey", () => {
  it("maps the no-project bucket back to null", () => {
    expect(projectIdFromBucketKey(NO_PROJECT_KEY)).toBeNull();
    expect(projectIdFromBucketKey("project-1")).toBe("project-1");
  });
});

describe("tabsForProjectBucket", () => {
  it("keeps only tabs that belong to the target project bucket", () => {
    const tabs = [
      { id: "p1", projectId: "project-1" },
      { id: "p2", projectId: "project-2" },
      { id: "none", projectId: null },
    ] as unknown as Tab[];

    expect(tabsForProjectBucket(tabs, "project-1").map((t) => t.id)).toEqual([
      "p1",
    ]);
    expect(tabsForProjectBucket(tabs, NO_PROJECT_KEY).map((t) => t.id)).toEqual([
      "none",
    ]);
  });
});

describe("nonEmptyProjectTabs", () => {
  it("drops empty agent tabs when project buckets are saved or restored", () => {
    const tabs = [
      {
        id: "blank",
        kind: "agent",
        label: "Tab 1",
        messages: [],
        draft: "",
        waiting: false,
        queueCount: 0,
        canvas: null,
        terminalBuffer: "",
      },
      {
        id: "chat",
        kind: "agent",
        label: "Chat",
        messages: [{ id: "m1", role: "user", text: "hi" }],
        draft: "",
        waiting: false,
        queueCount: 0,
        canvas: null,
        terminalBuffer: "",
      },
      { id: "shell", kind: "shell", messages: [] },
    ] as unknown as Tab[];

    expect(nonEmptyProjectTabs(tabs).map((t) => t.id)).toEqual([
      "chat",
      "shell",
    ]);
  });
});
