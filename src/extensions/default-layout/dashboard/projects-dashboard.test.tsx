// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsDashboard } from "./projects-dashboard";
import type { A2UIComponent } from "../../../types/a2ui";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../../ExtensionRegistryProvider";
import { TaskLauncher } from "./task-launcher";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === "read_config") {
      return {
        ui: {},
        agent: {},
        shell: {},
        shortcuts: {},
        voice: {},
        updates: {},
        devshell: {},
        startup: { autoApprove: false },
        guardrails: {},
      };
    }
    return null;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config")>();
  return {
    ...actual,
    clearConfigCache: vi.fn(),
  };
});

function dashboard(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "projects-dashboard",
    type: "projects-dashboard",
    props,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

    expect(screen.getByTestId("host-launcher-override").textContent).toBe(
      "true",
    );
  });

  it("writes host-level startup auto-approve to global config", async () => {
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
            host: {
              id: "local:halcyon",
              hostname: "halcyon",
              displayName: "halcyon",
              isLocal: true,
            },
            projects: [{ id: "p1", label: "aethon", path: "/repo/aethon" }],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /auto-approve startup commands on this host/i,
    }) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "write_config",
        expect.objectContaining({
          config: expect.objectContaining({
            startup: expect.objectContaining({ autoApprove: true }),
          }),
        }),
      ),
    );
    expect(checkbox.checked).toBe(true);
  });
});
