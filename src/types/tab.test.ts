import { describe, expect, it } from "vitest";
import {
  NO_PROJECT_KEY,
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
