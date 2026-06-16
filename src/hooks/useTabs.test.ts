import { describe, expect, it } from "vitest";
import { emptyProjectsState } from "../projects";
import { makeEmptyTab } from "../types/tab";
import {
  cwdForNewTab,
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
      activeWorkspaceId: null,
      workspacesByProject: {},
      activeHostId: null,
      projects: [{ id: "p1", label: "mold", path: "/repo/mold", lastUsed: 1 }],
    };

    expect(recentSessionItemFromClosedTab(tab, projects)).toEqual({
      id: "default",
      label: "Tell me about this application in detail",
      lastModified: "now",
      cwd: "/repo/mold",
    });
  });

  it("keeps a closed workspace chat scoped to its original cwd", () => {
    const tab = {
      ...makeEmptyTab("workspace-tab", "Tab 1", "p1"),
      cwd: "/repo/mold-fix-session-restore",
      messages: [
        {
          id: "m1",
          role: "user" as const,
          text: "Recover this branch session",
        },
      ],
    };
    const projects = {
      activeId: "p1",
      activeWorkspaceId: "wt-1",
      workspacesByProject: {
        p1: [
          {
            id: "wt-1",
            projectId: "p1",
            path: "/repo/mold-fix-session-restore",
            branch: "fix/session-restore",
            isMain: false,
          },
        ],
      },
      activeHostId: null,
      projects: [{ id: "p1", label: "mold", path: "/repo/mold", lastUsed: 1 }],
    };

    expect(recentSessionItemFromClosedTab(tab, projects)).toEqual({
      id: "workspace-tab",
      label: "Recover this branch session",
      lastModified: "now",
      cwd: "/repo/mold-fix-session-restore",
    });
  });

  it("does not create history entries for empty tabs", () => {
    expect(
      recentSessionItemFromClosedTab(
        makeEmptyTab("t1", "Tab 1"),
        emptyProjectsState(),
      ),
    ).toBeNull();
  });
});

describe("modelForNewProjectTab", () => {
  it("prefers the chosen default over per-project memory (global wins everywhere)", () => {
    expect(
      modelForNewProjectTab(
        {
          defaultModel: "openai/gpt-5.5",
          projectModels: { p1: "anthropic/claude-opus-4-7" },
        },
        "p1",
        "openai/gpt-5-mini",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("falls back to per-project memory then pi default when no default is set", () => {
    expect(
      modelForNewProjectTab(
        { projectModels: { p1: "anthropic/claude-opus-4-7" } },
        "p1",
        "fallback",
      ),
    ).toBe("anthropic/claude-opus-4-7");
    expect(modelForNewProjectTab({}, "p1", "fallback")).toBe("fallback");
  });
});

describe("cwdForNewTab", () => {
  it("prefers the active project cwd", () => {
    const projects = {
      activeId: "p1",
      activeWorkspaceId: null,
      workspacesByProject: {},
      activeHostId: null,
      projects: [
        { id: "p1", label: "Aethon", path: "/repo/aethon", lastUsed: 1 },
      ],
    };

    expect(
      cwdForNewTab(projects, {
        aethonRoot: "/Users/me/.aethon",
        projectRoot: "/fallback",
      }),
    ).toBe("/repo/aethon");
  });

  it("falls back to the Aethon user dir when no project is selected", () => {
    expect(
      cwdForNewTab(emptyProjectsState(), {
        aethonRoot: "/Users/me/.aethon",
        projectRoot: "/repo/aethon",
      }),
    ).toBe("/Users/me/.aethon");
  });

  it("falls back to the dev project root when the user dir is unavailable", () => {
    expect(
      cwdForNewTab(emptyProjectsState(), { projectRoot: "/repo/aethon" }),
    ).toBe("/repo/aethon");
  });
});
