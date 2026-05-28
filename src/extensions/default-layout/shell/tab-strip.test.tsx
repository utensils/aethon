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

  it("keeps rename input focused while active agent state re-renders", () => {
    const onEvent = vi.fn<TabStripOnEvent>();
    const { rerender } = render(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", label: "Tab 1", kind: "agent", waiting: true }],
        }}
        onEvent={onEvent}
      />,
    );
    fireEvent.contextMenu(screen.getByText("Tab 1").closest('[role="tab"]')!);
    const input = screen.getByLabelText("Session name");
    input.focus();
    fireEvent.change(input, { target: { value: "Planning" } });

    rerender(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              label: "Tab 1",
              kind: "agent",
              waiting: true,
              queueCount: 1,
            },
          ],
        }}
        onEvent={onEvent}
      />,
    );

    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("value", "Planning");
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

  it("keeps the new-tab affordance available when no tabs are open", () => {
    const onEvent = vi.fn<TabStripOnEvent>();
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{ activeTabId: null, tabs: [] }}
        onEvent={onEvent}
      />,
    );

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(onEvent).toHaveBeenCalledWith("new");
  });
});
