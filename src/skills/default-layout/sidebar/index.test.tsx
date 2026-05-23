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
