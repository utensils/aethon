import { describe, expect, it } from "vitest";
import { removeProject, upsertProject, type ProjectsState } from "./projects";

function stateWithProjects(): ProjectsState {
  const first = upsertProject(
    { projects: [], activeId: null },
    "/Users/example/aethon",
  ).state;
  return upsertProject(first, "/Users/example/latentforge").state;
}

describe("removeProject", () => {
  it("removes only the project metadata record", () => {
    const state = stateWithProjects();
    const target = state.projects.find((p) => p.label === "aethon");

    const result = removeProject(state, target!.id);

    expect(result.removed?.path).toBe("/Users/example/aethon");
    expect(result.state.projects.map((p) => p.path)).toEqual([
      "/Users/example/latentforge",
    ]);
  });

  it("clears activeId when removing the active project", () => {
    const state = stateWithProjects();

    const result = removeProject(state, state.activeId!);

    expect(result.state.activeId).toBeNull();
  });

  it("preserves activeId when removing an inactive project", () => {
    const state = stateWithProjects();
    const activeId = state.activeId!;
    const inactive = state.projects.find((p) => p.id !== activeId)!;

    const result = removeProject(state, inactive.id);

    expect(result.state.activeId).toBe(activeId);
  });
});
