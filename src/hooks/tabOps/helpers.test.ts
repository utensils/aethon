import { describe, expect, it } from "vitest";
import {
  activeHostIdForNewTab,
  activeProjectIdForNewTab,
  cwdForNewTab,
  modelForNewProjectTab,
  projectCwdForNewTab,
} from "./helpers";
import { isRemoteHostId } from "../../remoteInvoke";
import { emptyProjectsState, type ProjectsState } from "../../projects";

describe("modelForNewProjectTab", () => {
  const fallback = "openai-codex/gpt-5.5";

  it("uses the explicit per-launch override above everything", () => {
    const state = {
      defaultModel: "anthropic/claude-opus-4-7",
      projectModels: { p1: "qwen/qwen3" },
    };
    expect(
      modelForNewProjectTab(state, "p1", fallback, "google/gemma-4"),
    ).toBe("google/gemma-4");
  });

  it("lets /defaultModel win over per-project memory (global wins everywhere)", () => {
    const state = {
      defaultModel: "anthropic/claude-opus-4-7",
      projectModels: { p1: "qwen/qwen3" },
    };
    expect(modelForNewProjectTab(state, "p1", fallback)).toBe(
      "anthropic/claude-opus-4-7",
    );
  });

  it("falls back to per-project memory when no default is set", () => {
    const state = { projectModels: { p1: "qwen/qwen3" } };
    expect(modelForNewProjectTab(state, "p1", fallback)).toBe("qwen/qwen3");
  });

  it("falls back to the pi default when nothing else resolves", () => {
    expect(modelForNewProjectTab({}, null, fallback)).toBe(fallback);
  });

  it("ignores an empty explicit override and trims the result", () => {
    const state = { defaultModel: "  anthropic/claude-opus-4-7  " };
    expect(modelForNewProjectTab(state, null, fallback, "")).toBe(
      "anthropic/claude-opus-4-7",
    );
  });

  it("ignores per-project memory when the active project is null", () => {
    const state = { projectModels: { p1: "qwen/qwen3" } };
    expect(modelForNewProjectTab(state, null, fallback)).toBe(fallback);
  });
});

describe("remote tab inheritance", () => {
  it("uses the selected remote project id when local projects have no active id", () => {
    const projects = emptyProjectsState("local:bender");
    const state = {
      activeProjectId: "remote:fp::project::p1",
      project: {
        id: "remote:fp::project::p1",
        hostId: "remote:fp",
        path: "/remote/repo",
      },
    };

    expect(activeProjectIdForNewTab(projects, state)).toBe(
      "remote:fp::project::p1",
    );
    expect(activeHostIdForNewTab(projects, state)).toBe("remote:fp");
  });

  it("prefers local active project host metadata when present", () => {
    const projects: ProjectsState = {
      ...emptyProjectsState("local:bender"),
      activeId: "p1",
      projects: [
        {
          id: "p1",
          label: "repo",
          path: "/repo",
          lastUsed: 1,
          hostId: "local:bender",
        },
      ],
    };

    expect(activeProjectIdForNewTab(projects, {})).toBe("p1");
    expect(activeHostIdForNewTab(projects, {})).toBe("local:bender");
    expect(isRemoteHostId("remote:abc")).toBe(true);
    expect(isRemoteHostId("local:bender")).toBe(false);
  });

  it("does not use local host fallback paths for remote host overview shells", () => {
    const projects = emptyProjectsState("local:bender");
    const state = {
      activeHostId: "remote:fp",
      aethonRoot: "/Users/example/.aethon",
      projectRoot: "/Users/example/Projects/aethon",
    };

    expect(activeHostIdForNewTab(projects, state)).toBe("remote:fp");
    expect(projectCwdForNewTab(projects, state)).toBeNull();
    expect(cwdForNewTab(projects, state)).toBe("/Users/example/.aethon");
  });
});
