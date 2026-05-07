import { describe, expect, it } from "vitest";
import { emptyProjectsState } from "../projects";
import { makeEmptyTab } from "../types/tab";
import {
  modelForNewProjectTab,
  recentSessionItemFromClosedTab,
} from "./useTabs";

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

describe("modelForNewProjectTab", () => {
  it("prefers the active project's last model over the global active model", () => {
    expect(
      modelForNewProjectTab(
        {
          model: "openai/gpt-5.5",
          projectModels: { p1: "anthropic/claude-opus-4-7" },
        },
        "p1",
        "openai/gpt-5-mini",
      ),
    ).toBe("anthropic/claude-opus-4-7");
  });

  it("falls back to visible model and then pi default", () => {
    expect(
      modelForNewProjectTab({ model: "openai/gpt-5.5" }, "p1", "fallback"),
    ).toBe("openai/gpt-5.5");
    expect(modelForNewProjectTab({}, "p1", "fallback")).toBe("fallback");
  });
});
