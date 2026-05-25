// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sidebar } from ".";
import type { A2UIComponent } from "../../../types/a2ui";
import type { ComponentProps } from "react";

afterEach(() => cleanup());

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
            },
          ],
        },
      },
    });

    expect(screen.getByText("extensions")).toBeTruthy();
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
            },
          ],
        },
      },
    });

    fireEvent.contextMenu(screen.getByText("mold-gallery").closest("li")!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Disable extension/ }));

    expect(onEvent).toHaveBeenCalledWith(
      "toggle-extension",
      {
        sectionId: "extensions",
        itemId: "ext:mold-gallery",
        name: "mold-gallery",
        disabled: true,
      },
    );
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
            },
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("switch"));

    // Toggle emits toggle-extension with the *target* disabled flag.
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
            },
          ],
        },
      },
    });

    fireEvent.click(screen.getByRole("switch"));
    expect(onEvent).toHaveBeenCalledWith(
      "toggle-extension",
      {
        sectionId: "extensions",
        itemId: "ext-disabled:silenced",
        name: "silenced",
        disabled: false,
      },
      "ext-disabled:silenced",
    );
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

    fireEvent.contextMenu(screen.getAllByText("aethon")[1].closest("li")!);
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
