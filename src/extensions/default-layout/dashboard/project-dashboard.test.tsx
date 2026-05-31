// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDashboard } from "./project-dashboard";
import type { A2UIComponent } from "../../../types/a2ui";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../../ExtensionRegistryProvider";

const { refreshRepoOverview } = vi.hoisted(() => ({
  refreshRepoOverview: vi.fn(
    (_projectPath: string) =>
      new Promise(() => {
        /* keep dashboard overview pending */
      }),
  ),
}));

vi.mock("../../../ghRepoOverviewCache", () => ({
  refreshRepoOverview: (projectPath: string) => refreshRepoOverview(projectPath),
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
          worktrees: [
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

    expect(container.querySelector(".a2ui-project-dashboard-hero img")).toBeNull();

    rerender(
      <ExtensionRegistryProvider registry={new ExtensionRegistry()}>
        <ProjectDashboard
          component={dashboard({
            project: {
              id: "p1",
              label: "nyc-real-estate",
              path: "/repo/nyc-real-estate",
            },
            worktrees: [],
            recentSessions: [],
            widgets: [],
            otherProjects: [],
          })}
          state={{
            sidebar: {
              projects: [
                {
                  id: "p1",
                  iconUrl: "asset://localhost/project-icons/nyc-real-estate.png",
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

describe("ProjectDashboard worktree removal", () => {
  it("opens inline confirmation from a worktree remove icon", () => {
    const { onEvent } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm remove feature-x" }).textContent,
    ).toBe("Confirm");
  });

  it("confirms worktree removal without switching the row", () => {
    const { onEvent } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "Remove feature-x" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm remove feature-x" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      "remove-worktree",
      expect.objectContaining({ worktreeId: "wt-1", confirmed: true }),
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
      "switch-worktree",
      expect.objectContaining({ worktreeId: "wt-1" }),
      "wt-1",
    );
  });

  it("does not show remove affordance for the main worktree", () => {
    renderDashboard();
    expect(screen.queryByRole("button", { name: "Remove main" })).toBeNull();
  });
});
