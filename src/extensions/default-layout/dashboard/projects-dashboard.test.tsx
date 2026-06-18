// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsDashboard } from "./projects-dashboard";
import type { A2UIComponent } from "../../../types/a2ui";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../../ExtensionRegistryProvider";
import { TaskLauncher } from "./task-launcher";

function dashboard(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "projects-dashboard",
    type: "projects-dashboard",
    props,
  };
}

afterEach(() => {
  cleanup();
});

describe("ProjectsDashboard", () => {
  it("renders a host-level task launcher with project selection", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });
    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            projects: [
              { id: "p1", label: "aethon", path: "/repo/aethon" },
              { id: "p2", label: "koban", path: "/repo/koban" },
            ],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByLabelText("Task prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeTruthy();
  });

  it("routes the host-level task launcher through the extension registry", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-task-launcher-override",
      components: {
        "task-launcher": ({ component }) => (
          <div data-testid="host-launcher-override">
            {String(component.props?.showProjectSelector)}
          </div>
        ),
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            projects: [
              { id: "p1", label: "aethon", path: "/repo/aethon" },
              { id: "p2", label: "koban", path: "/repo/koban" },
            ],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByTestId("host-launcher-override").textContent).toBe("true");
  });
});
