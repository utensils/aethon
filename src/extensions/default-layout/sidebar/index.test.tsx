// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// Force the macOS branch so the brand-strip drag-region assertion is
// deterministic under jsdom (navigator.platform is empty there).
vi.mock("../../../utils/platform", () => ({ isMacOS: () => true }));
import { Sidebar } from ".";
import type { A2UIComponent } from "../../../types/a2ui";
import type { ComponentProps } from "react";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

type SidebarOnEvent = ComponentProps<typeof Sidebar>["onEvent"];
type SidebarOnEventMock = ReturnType<typeof vi.fn<SidebarOnEvent>>;

function sidebarComponent(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "sidebar",
    type: "sidebar",
    props,
  };
}

function renderSidebar({
  props = {},
  state = {},
  onEvent = vi.fn<SidebarOnEvent>(),
}: {
  props?: Record<string, unknown>;
  state?: Record<string, unknown>;
  onEvent?: SidebarOnEventMock;
} = {}) {
  render(
    <Sidebar
      component={sidebarComponent({
        title: "aethon",
        sections: [
          {
            id: "projects",
            title: "projects",
            items: [{ id: "project:aethon", label: "aethon" }],
          },
        ],
        ...props,
      })}
      state={state}
      onEvent={onEvent}
      renderChildWithState={() => null}
    />,
  );
  return { onEvent };
}

describe("Sidebar extension controls", () => {
  it("auto-renders extension controls when extension items are hydrated", () => {
    renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold-gallery",
              label: "mold-gallery",
              hint: "project",
              active: true,
              kind: "project",
            },
          ],
        },
      },
    });

    // Qualified section title — always present even when only one
    // bucket has rows so scope is never ambiguous.
    expect(screen.getByText("project extensions")).toBeTruthy();
    expect(screen.getByText("mold-gallery")).toBeTruthy();
    expect(screen.getByText("project")).toBeTruthy();
  });

  it("routes extension toggles from the auto-rendered context menu", () => {
    const { onEvent } = renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold-gallery",
              label: "mold-gallery",
              hint: "project",
              active: true,
              kind: "project",
            },
          ],
        },
      },
    });

    fireEvent.contextMenu(screen.getByText("mold-gallery").closest("li")!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Disable extension/ }),
    );

    expect(onEvent).toHaveBeenCalledWith("toggle-extension", {
      sectionId: "extensions",
      itemId: "ext:mold-gallery",
      name: "mold-gallery",
      disabled: true,
    });
  });

  it("renders an inline toggle switch on each extension row", () => {
    renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold-gallery",
              label: "mold-gallery",
              hint: "project",
            },
            {
              id: "ext-disabled:silenced",
              label: "silenced",
              hint: "disabled",
            },
            {
              id: "ext-failed:boom",
              label: "boom",
              hint: "load failed",
            },
          ],
        },
      },
    });

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    expect(switches[0].getAttribute("aria-checked")).toBe("true"); // ext: → on
    expect(switches[1].getAttribute("aria-checked")).toBe("false"); // ext-disabled: → off
    expect(switches[2].getAttribute("aria-checked")).toBe("false"); // ext-failed: → off
    expect(switches[2].getAttribute("aria-disabled")).toBe("true"); // failed is interactive-disabled
  });

  it("flips an enabled extension via the inline toggle without firing the row's select", () => {
    const { onEvent } = renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold-gallery",
              label: "mold-gallery",
              hint: "project",
              kind: "project",
            },
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("switch"));

    // Toggle emits toggle-extension with the *target* disabled flag.
    // SectionId reflects the bucket the item lands in (`extensions` for
    // project, `extensions-user` for user, `extensions-package` for npm).
    expect(onEvent).toHaveBeenCalledWith(
      "toggle-extension",
      {
        sectionId: "extensions",
        itemId: "ext:mold-gallery",
        name: "mold-gallery",
        disabled: true,
      },
      "ext:mold-gallery",
    );
    // The outer row's "select" handler must not fire — that would
    // bounce the user into the extension's pane on every toggle.
    const selectCalls = onEvent.mock.calls.filter(
      (call) => call[0] === "select",
    );
    expect(selectCalls).toHaveLength(0);
  });

  it("re-enables a disabled extension via the inline toggle", () => {
    const { onEvent } = renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext-disabled:silenced",
              label: "silenced",
              kind: "user",
            },
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("switch"));
    // User-bucket items live in the extensions-user sub-section.
    expect(onEvent).toHaveBeenCalledWith(
      "toggle-extension",
      {
        sectionId: "extensions-user",
        itemId: "ext-disabled:silenced",
        name: "silenced",
        disabled: false,
      },
      "ext-disabled:silenced",
    );
  });

  it("splits the auto-injected EXTENSIONS section by origin (project / user)", () => {
    renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold:gallery",
              label: "mold:gallery",
              hint: "project",
              kind: "project",
            },
            {
              id: "ext:user-helper",
              label: "user-helper",
              hint: "user",
              kind: "user",
            },
            {
              id: "ext:@brink/widget",
              label: "@brink/widget",
              hint: "user",
              kind: "user",
            },
          ],
        },
      },
    });

    // Two subgroup titles appear; the user can tell scope at a glance
    // even without reading the per-row hints.
    expect(screen.getByText("project extensions")).toBeTruthy();
    expect(screen.getByText("user extensions")).toBeTruthy();
  });

  it("keeps the qualified group title even when only one origin bucket has items", () => {
    renderSidebar({
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:user-only",
              label: "user-only",
              hint: "user",
              kind: "user",
            },
          ],
        },
      },
    });

    // Origin label stays so the user can read scope at a glance even
    // with a single extension loaded — that's exactly when knowing
    // whether it's a user-level or project-level addition matters.
    expect(screen.getByText("user extensions")).toBeTruthy();
    expect(screen.queryByText("project extensions")).toBeNull();
  });

  it("does not duplicate a layout-provided extensions section", () => {
    renderSidebar({
      props: {
        sections: [
          {
            id: "extensions",
            title: "custom extensions",
            items: [{ id: "manual", label: "Manual row" }],
          },
        ],
      },
      state: {
        sidebar: {
          extensions: [
            {
              id: "ext:mold-gallery",
              label: "mold-gallery",
              hint: "project",
              active: true,
            },
          ],
        },
      },
    });

    expect(screen.getByText("custom extensions")).toBeTruthy();
    expect(screen.getByText("Manual row")).toBeTruthy();
    expect(screen.queryByText("mold-gallery")).toBeNull();
  });

  it("hides empty sections that opt into hideWhenEmpty", () => {
    renderSidebar({
      props: {
        sections: [
          {
            id: "extensions",
            title: "extensions",
            items: { $ref: "/sidebar/extensions" },
            hideWhenEmpty: true,
          },
        ],
      },
      state: {
        sidebar: {
          extensions: [],
        },
      },
    });

    expect(screen.queryByText("extensions")).toBeNull();
  });
});

describe("Sidebar project menu", () => {
  it("starts inline worktree rename from the context menu without prompt", () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("prompt label");
    const { onEvent } = renderSidebar({
      props: {
        sections: [
          {
            id: "projects",
            title: "projects",
            items: [
              {
                id: "project-1",
                label: "aethon",
                expanded: true,
                worktrees: [
                  {
                    id: "main",
                    label: "main",
                    branch: "main",
                    path: "/repo",
                    active: false,
                    isMain: true,
                  },
                  {
                    id: "wt-1",
                    label: "feature-x",
                    branch: "feature-x",
                    path: "/repo-feature-x",
                    active: false,
                    isMain: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    fireEvent.contextMenu(screen.getByText("feature-x").closest("li")!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Rename worktree/ }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    const input = screen.getByRole("textbox", { name: /rename worktree/i });
    expect((input as HTMLInputElement).value).toBe("feature-x");

    fireEvent.change(input, { target: { value: "renamed feature" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEvent).toHaveBeenCalledWith(
      "rename-worktree",
      expect.objectContaining({
        sectionId: "projects",
        itemId: "wt-1",
        worktreeId: "wt-1",
        label: "renamed feature",
      }),
      "wt-1",
    );
  });

  it("emits the project worktree base event", () => {
    const { onEvent } = renderSidebar({
      props: {
        sections: [
          {
            id: "projects",
            title: "projects",
            items: [{ id: "project-1", label: "aethon" }],
          },
        ],
      },
      state: {
        projects: [
          {
            id: "project-1",
            label: "aethon",
            path: "/projects/aethon",
            worktreeBaseBranch: "origin/main",
          },
        ],
      },
    });

    // The brand row now renders the AeWordmark SVG (aria-label "Æthon"),
    // not the literal text "aethon", so the only "aethon" text node is the
    // project row label.
    fireEvent.contextMenu(screen.getByText("aethon").closest("li")!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Set worktree base/ }),
    );
    fireEvent.change(screen.getByLabelText("Base branch"), {
      target: { value: "upstream/trunk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onEvent).toHaveBeenCalledWith("set-project-worktree-base", {
      sectionId: "projects",
      itemId: "project-1",
      projectId: "project-1",
      baseBranch: "upstream/trunk",
    });
  });
});

describe("Sidebar host groups", () => {
  function renderWithHost({
    onEvent = vi.fn<SidebarOnEvent>(),
    projectItem = { id: "project:aethon", label: "aethon" },
    hosts = [
      { id: "local:abc", label: "halcyon", hint: "this mac", active: true },
    ],
  }: {
    onEvent?: SidebarOnEventMock;
    projectItem?: Record<string, unknown>;
    hosts?: Record<string, unknown>[];
  } = {}) {
    render(
      <Sidebar
        component={sidebarComponent({
          brandMark: true,
          version: "v9.9",
          hostGroups: true,
          hosts: { $ref: "/sidebar/hosts" },
          sections: [
            {
              id: "projects",
              title: "projects",
              items: { $ref: "/sidebar/projects" },
            },
          ],
        })}
        state={{ sidebar: { hosts, projects: [projectItem] } }}
        onEvent={onEvent}
        renderChildWithState={() => null}
      />,
    );
    return { onEvent };
  }

  it("renders the host header with name + this-mac badge above the projects", () => {
    renderWithHost();
    expect(screen.getByText("halcyon")).toBeTruthy();
    expect(screen.getByText("this mac")).toBeTruthy();
    // The project nests inside the active host's group body.
    const project = screen.getByText("aethon").closest("li");
    expect(project?.closest(".ae-host-group-body")).toBeTruthy();
  });

  it("switches the active host when a host header is clicked", () => {
    const { onEvent } = renderWithHost({
      hosts: [
        { id: "local:abc", label: "halcyon", hint: "this mac", active: true },
        {
          id: "remote:bender",
          label: "bender",
          hint: "bender.local",
          active: false,
        },
      ],
    });
    fireEvent.click(screen.getByText("bender"));
    expect(onEvent).toHaveBeenCalledWith(
      "select",
      { sectionId: "hosts", itemId: "remote:bender" },
      "remote:bender",
    );
  });

  it("renders project rows as two-line cards with branch + ahead/behind meta", () => {
    renderWithHost({
      projectItem: {
        id: "project:aethon",
        label: "aethon",
        git: { branch: "feat/sidebar", dirty: true, ahead: 2, behind: 1 },
      },
    });
    const row = screen.getByText("aethon").closest("li");
    expect(row?.classList.contains("a2ui-sidebar-item-stacked")).toBe(true);
    expect(screen.getByText("feat/sidebar")).toBeTruthy();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.getByText("↓1")).toBeTruthy();
  });

  it("makes the brand strip a macOS window drag region", () => {
    const { container } = render(
      <Sidebar
        component={sidebarComponent({
          brandMark: true,
          version: "v1",
          sections: [],
        })}
        state={{}}
        onEvent={vi.fn<SidebarOnEvent>()}
        renderChildWithState={() => null}
      />,
    );
    const title = container.querySelector(".a2ui-sidebar-title");
    expect(title?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });
});
