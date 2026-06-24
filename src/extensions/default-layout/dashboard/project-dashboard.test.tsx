// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDashboard } from "./project-dashboard";
import type { A2UIComponent } from "../../../types/a2ui";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../../ExtensionRegistryProvider";

const { invokeMock, refreshRepoOverview } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === "workspace_startup_status") {
      return {
        root: "/repo",
        autoApprove: false,
        hostAutoApprove: false,
        projectAutoApprove: false,
      };
    }
    if (command === "workspace_startup_set_auto_approve") {
      return {
        root: "/repo",
        autoApprove: true,
        hostAutoApprove: false,
        projectAutoApprove: true,
      };
    }
    return null;
  }),
  refreshRepoOverview: vi.fn(
    (_projectPath: string) =>
      new Promise(() => {
        /* keep dashboard overview pending */
      }),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../../ghRepoOverviewCache", () => ({
  refreshRepoOverview: (projectPath: string) =>
    refreshRepoOverview(projectPath),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function dashboard(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "project-dashboard",
    type: "project-dashboard",
    props,
  };
}

function renderDashboard(
  onEvent = vi.fn(),
  project: Record<string, unknown> = {
    id: "p1",
    label: "aethon",
    path: "/repo",
  },
  state: Record<string, unknown> = {},
) {
  const registry = new ExtensionRegistry();
  const result = render(
    <ExtensionRegistryProvider registry={registry}>
      <ProjectDashboard
        component={dashboard({
          project,
          workspaces: [
            {
              id: "main",
              label: "main",
              branch: "main",
              path: "/repo",
              isMain: true,
            },
            {
              id: "wt-1",
              label: "feature-x",
              branch: "feature-x",
              path: "/repo-feature-x",
            },
          ],
          recentSessions: [],
          widgets: [],
          otherProjects: [],
        })}
        state={state}
        onEvent={onEvent}
      />
    </ExtensionRegistryProvider>,
  );
  return { onEvent, ...result };
}

describe("ProjectDashboard project icon", () => {
  it("force-refreshes repo overview when the project dashboard loads", () => {
    renderDashboard();

    expect(refreshRepoOverview).toHaveBeenCalledWith("/repo");
  });

  it("uses the discovered project icon in the hero when one is available", () => {
    const { container } = renderDashboard(vi.fn(), {
      id: "p1",
      label: "Claudette",
      path: "/repo/claudette",
      iconUrl: "asset://localhost/project-icons/claudette.png",
    });

    const hero = container.querySelector(".a2ui-project-dashboard-hero")!;
    const image = hero.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "asset://localhost/project-icons/claudette.png",
    );
    expect(hero.querySelector("svg")).toBeNull();
  });

  it("derives the project icon from live sidebar state", () => {
    const { container, rerender } = renderDashboard(
      vi.fn(),
      {
        id: "p1",
        label: "nyc-real-estate",
        path: "/repo/nyc-real-estate",
      },
      {
        sidebar: { projects: [{ id: "p1" }] },
      },
    );

    expect(
      container.querySelector(".a2ui-project-dashboard-hero img"),
    ).toBeNull();

    rerender(
      <ExtensionRegistryProvider registry={new ExtensionRegistry()}>
        <ProjectDashboard
          component={dashboard({
            project: {
              id: "p1",
              label: "nyc-real-estate",
              path: "/repo/nyc-real-estate",
            },
            workspaces: [],
            recentSessions: [],
            widgets: [],
            otherProjects: [],
          })}
          state={{
            sidebar: {
              projects: [
                {
                  id: "p1",
                  iconUrl:
                    "asset://localhost/project-icons/nyc-real-estate.png",
                },
              ],
            },
          }}
          onEvent={vi.fn()}
        />
      </ExtensionRegistryProvider>,
    );

    expect(
      container
        .querySelector(".a2ui-project-dashboard-hero img")
        ?.getAttribute("src"),
    ).toBe("asset://localhost/project-icons/nyc-real-estate.png");
  });
});

describe("ProjectDashboard startup policy", () => {
  it("writes the project startup auto-approve setting", async () => {
    renderDashboard();

    const checkbox = screen.getByRole("checkbox", {
      name: /auto-approve startup commands/i,
    }) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "workspace_startup_set_auto_approve",
        { args: { root: "/repo", enabled: true } },
      ),
    );
    expect(checkbox.checked).toBe(true);
  });
});

describe("ProjectDashboard workspace removal", () => {
  it("opens inline confirmation from a workspace remove icon", () => {
    const { onEvent } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm remove feature-x" })
        .textContent,
    ).toBe("Confirm");
  });

  it("confirms workspace removal without switching the row", () => {
    const { onEvent } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm remove feature-x" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      "remove-workspace",
      expect.objectContaining({ workspaceId: "wt-1", confirmed: true }),
      "wt-1",
    );
  });

  it("clears inline confirmation when the pointer leaves", () => {
    const { onEvent } = renderDashboard();
    const row = screen.getByText("feature-x").closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    fireEvent.mouseLeave(row);
    expect(
      screen.queryByRole("button", { name: "Confirm remove feature-x" }),
    ).toBeNull();
    fireEvent.click(row);
    expect(onEvent).toHaveBeenCalledWith(
      "switch-workspace",
      expect.objectContaining({ workspaceId: "wt-1" }),
      "wt-1",
    );
  });

  it("does not show remove affordance for the main workspace", () => {
    renderDashboard();
    expect(screen.queryByRole("button", { name: "Remove main" })).toBeNull();
  });
});
