import { describe, expect, it } from "vitest";
import { emptyProjectsState } from "../projects";
import { makeEmptyTab } from "../types/tab";
import { recentSessionItemFromClosedTab } from "./useTabs";

describe("recentSessionItemFromClosedTab", () => {
  it("keeps a closed chat tab available for history restore", () => {
    const tab = {
      ...makeEmptyTab("default", "Tab 1", "p1"),
      messages: [
        {
          id: "m1",
          role: "user" as const,
          text: "Tell me about this application in detail",
        },
      ],
    };
    const projects = {
      activeId: "p1",
      projects: [
        { id: "p1", label: "mold", path: "/repo/mold", lastUsed: 1 },
      ],
    };

    expect(recentSessionItemFromClosedTab(tab, projects)).toEqual({
      id: "default",
      label: "Tell me about this application in detail",
      lastModified: "now",
      cwd: "/repo/mold",
    });
  });

  it("does not create history entries for empty tabs", () => {
    expect(
      recentSessionItemFromClosedTab(makeEmptyTab("t1", "Tab 1"), emptyProjectsState()),
    ).toBeNull();
  });
});
