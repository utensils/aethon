// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TabStrip } from "./tab-strip";
import type { A2UIComponent } from "../../../types/a2ui";

afterEach(() => cleanup());

type TabStripOnEvent = ComponentProps<typeof TabStrip>["onEvent"];

function tabStripComponent(): A2UIComponent {
  return {
    id: "header-tabs",
    type: "tab-strip",
    props: {
      tabs: { $ref: "/tabs" },
      activeId: { $ref: "/activeTabId" },
    },
  };
}

function renderTabStrip(onEvent = vi.fn<TabStripOnEvent>()) {
  render(
    <TabStrip
      component={tabStripComponent()}
      state={{
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", label: "Tab 1", kind: "agent" },
          { id: "shell-1", label: "Shell 1", kind: "shell" },
        ],
      }}
      onEvent={onEvent}
    />,
  );
  return { onEvent };
}

describe("TabStrip", () => {
  it("opens tab actions on right-click and emits a rename event", () => {
    const { onEvent } = renderTabStrip();
    fireEvent.contextMenu(screen.getByText("Tab 1").closest('[role="tab"]')!);

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Planning" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(onEvent).toHaveBeenCalledWith("rename", {
      tabId: "tab-1",
      label: "Planning",
    });
  });

  it("does not select the tab on right-button mouse down", () => {
    const { onEvent } = renderTabStrip();
    fireEvent.mouseDown(screen.getByText("Tab 1").closest('[role="tab"]')!, {
      button: 2,
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("continues filtering shell tabs from the top strip", () => {
    renderTabStrip();

    expect(screen.getByText("Tab 1")).toBeTruthy();
    expect(screen.queryByText("Shell 1")).toBeNull();
  });
});
