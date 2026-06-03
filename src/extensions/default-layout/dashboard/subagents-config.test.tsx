// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsConfig } from "./subagents-config";
import type { A2UIComponent } from "../../../types/a2ui";
import type { SubagentFile } from "../../../subagents";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const userReviewer: SubagentFile = {
  scope: "user",
  name: "reviewer",
  filePath: "/u/agents/reviewer.md",
  content:
    "---\ndescription: Reviews diffs\nmodel: ollama/llama3.3\n---\nYou review.",
};
const projectPlanner: SubagentFile = {
  scope: "project",
  name: "planner",
  filePath: "/p/.aethon/agents/planner.md",
  content: "---\ndescription: Plans work\nsurface: tab\n---\nYou plan.",
};

function comp(props: Record<string, unknown>): A2UIComponent {
  return { id: "subagents-config", type: "subagents-config", props };
}

const state = {
  sidebar: { models: [{ id: "ollama/llama3.3", label: "Llama 3.3" }] },
};

function mockList(files: SubagentFile[]): void {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "subagents_list") return Promise.resolve(files);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  mockList([userReviewer, projectPlanner]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubagentsConfig", () => {
  it("lists subagents for the user scope only", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "user" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());
    expect(screen.queryByText("planner")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("subagents_list", {
      projectRoot: null,
    });
  });

  it("lists project-scope subagents with the project root", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "project", projectPath: "/p" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("planner")).toBeTruthy());
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("subagents_list", {
      projectRoot: "/p",
    });
  });

  it("creates a new subagent and writes a serialized file", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "user" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());

    fireEvent.click(screen.getByText("+ New subagent"));
    fireEvent.change(screen.getByPlaceholderText("reviewer"), {
      target: { value: "builder" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Reviews diffs for correctness/),
      { target: { value: "Builds features" } },
    );
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "subagents_write",
        expect.objectContaining({
          scope: "user",
          name: "builder",
          projectRoot: null,
        }),
      ),
    );
    const writeCall = invoke.mock.calls.find((c) => c[0] === "subagents_write");
    expect(writeCall?.[1].content).toContain("description: Builds features");
  });

  it("blocks save when the description is empty", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "user" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());
    fireEvent.click(screen.getByText("+ New subagent"));
    fireEvent.change(screen.getByPlaceholderText("reviewer"), {
      target: { value: "builder" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(screen.getByText(/description is required/i)).toBeTruthy(),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "subagents_write")).toBe(
      false,
    );
  });

  it("deletes a subagent", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "user" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("subagents_delete", {
        scope: "user",
        name: "reviewer",
        projectRoot: null,
      }),
    );
  });

  it("renames by writing the new file before deleting the old", async () => {
    render(
      <SubagentsConfig
        component={comp({ scope: "user" })}
        state={state}
        onEvent={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit"));
    const nameInput = screen.getByDisplayValue("reviewer");
    fireEvent.change(nameInput, { target: { value: "auditor" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("subagents_delete", {
        scope: "user",
        name: "reviewer",
        projectRoot: null,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "subagents_write",
      expect.objectContaining({ name: "auditor" }),
    );
    // Write must land before the delete so a failed write can't lose the
    // original definition.
    const writeIdx = invoke.mock.calls.findIndex(
      (c) => c[0] === "subagents_write",
    );
    const deleteIdx = invoke.mock.calls.findIndex(
      (c) => c[0] === "subagents_delete",
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(deleteIdx);
  });
});
