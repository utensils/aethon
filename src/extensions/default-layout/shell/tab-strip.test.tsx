// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TabStrip } from "./tab-strip";
import type { A2UIComponent } from "../../../types/a2ui";
import { OVERVIEW_TAB_ID } from "../../../types/tab";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

function setRect(element: Element, rect: Partial<DOMRect>) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    right: rect.right ?? 100,
    bottom: rect.bottom ?? 20,
    width: rect.width ?? 100,
    height: rect.height ?? 20,
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    toJSON: () => ({}),
  });
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
  it("starts inline session rename from the tab context menu", () => {
    const { onEvent } = renderTabStrip();
    fireEvent.contextMenu(screen.getByText("Tab 1").closest('[role="tab"]')!);

    expect(screen.queryByLabelText("Session name")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Session" }));

    const input = screen.getByRole("textbox", {
      name: "Rename session Tab 1",
    });
    fireEvent.change(input, {
      target: { value: "Planning" },
    });
    expect(input).toHaveProperty("value", "Planning");
    expect(
      screen.queryByRole("menuitem", { name: "Rename Session" }),
    ).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Session" }));
    const input = screen.getByRole("textbox", {
      name: "Rename session Tab 1",
    });
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

    // The overview pill is the only entry in the strip when there are
    // no real tabs — every other role="tab" should be a session pill.
    const tabRoles = screen.queryAllByRole("tab");
    expect(tabRoles).toHaveLength(1);
    expect(tabRoles[0].textContent).toContain("overview");
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    expect(onEvent).toHaveBeenCalledWith("new");
  });

  it("renders the overview pill as the leftmost, non-closable tab", () => {
    renderTabStrip();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].textContent).toContain("overview");
    // No close button on the overview pill.
    expect(tabs[0].querySelector(".a2ui-tab-close")).toBeNull();
    // Real tabs do have one.
    expect(
      screen
        .getByText("Tab 1")
        .closest('[role="tab"]')!
        .querySelector(".a2ui-tab-close"),
    ).not.toBeNull();
  });

  it("emits select with the overview sentinel when the pill is clicked", () => {
    const { onEvent } = renderTabStrip();
    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    fireEvent.mouseDown(overviewPill, { button: 0 });
    expect(onEvent).toHaveBeenCalledWith("select", { tabId: OVERVIEW_TAB_ID });
  });

  it("opens the Aethon context menu for the overview pill and suppresses the native menu", () => {
    const { onEvent } = renderTabStrip();
    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 16,
    });

    fireEvent(overviewPill, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("menu", { name: "Tab actions" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "New Tab" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Close Others" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Close All Sessions" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Close Others" }));
    expect(onEvent).toHaveBeenCalledWith("close-others", {
      tabId: OVERVIEW_TAB_ID,
    });
  });

  it("marks the overview pill active when no tab id is set", () => {
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{ activeTabId: OVERVIEW_TAB_ID, tabs: [] }}
        onEvent={vi.fn<TabStripOnEvent>()}
      />,
    );
    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    expect(overviewPill.getAttribute("aria-selected")).toBe("true");
    expect(overviewPill.className).toContain("a2ui-tab-active");
  });

  it("marks overview active when activeTabId points at a filtered shell tab", () => {
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "shell-1",
          tabs: [
            { id: "tab-1", label: "Tab 1", kind: "agent" },
            { id: "shell-1", label: "Shell 1", kind: "shell" },
          ],
        }}
        onEvent={vi.fn<TabStripOnEvent>()}
      />,
    );

    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    expect(screen.queryByText("Shell 1")).toBeNull();
    expect(overviewPill.getAttribute("aria-selected")).toBe("true");
    expect(overviewPill.className).toContain("a2ui-tab-active");
  });

  it("marks the overview pill inactive when a real tab is selected", () => {
    renderTabStrip();
    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    expect(overviewPill.getAttribute("aria-selected")).toBe("false");
    expect(overviewPill.className).not.toContain("a2ui-tab-active");
  });

  it("shows an editor-specific context menu (copy path + close family)", () => {
    const onEvent = vi.fn<TabStripOnEvent>();
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "ed-1",
          project: { path: "/repo" },
          tabs: [
            {
              id: "ed-1",
              label: "App.tsx",
              kind: "editor",
              editor: { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
            },
          ],
        }}
        onEvent={onEvent}
      />,
    );
    fireEvent.contextMenu(screen.getByText("App.tsx").closest('[role="tab"]')!);
    // Editor menu, not the agent rename input.
    expect(screen.queryByLabelText("Session name")).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Copy Relative Path/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Others" }));
    expect(onEvent).toHaveBeenCalledWith("close-others", { tabId: "ed-1" });
  });

  it("emits a reorder event when a top tab is dragged before another tab", () => {
    const onEvent = vi.fn<TabStripOnEvent>();
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "ag-1",
          tabs: [
            { id: "ag-1", label: "Chat", kind: "agent" },
            { id: "sh-1", label: "Shell", kind: "shell" },
            {
              id: "ed-1",
              label: "App.tsx",
              kind: "editor",
              editor: { filePath: "/repo/App.tsx" },
            },
          ],
        }}
        onEvent={onEvent}
      />,
    );
    const chat = screen.getByText("Chat").closest('[role="tab"]')!;
    const editor = screen.getByText("App.tsx").closest('[role="tab"]')!;
    setRect(chat, { left: 0, width: 100 });

    fireEvent.pointerDown(editor, { button: 0, clientX: 120, clientY: 8 });
    fireEvent.pointerMove(document, { clientX: 10, clientY: 8 });

    expect(editor.className).toContain("a2ui-tab-dragging");
    expect(editor.getAttribute("style")).toContain("--ae-tab-drag-x");
    expect(chat.className).toContain("a2ui-tab-drop-before");

    fireEvent.pointerUp(document, { clientX: 10, clientY: 8 });

    expect(onEvent).toHaveBeenCalledWith("reorder", {
      tabId: "ed-1",
      toIndex: 0,
    });
  });

  it("does not let drag click suppression leak into the next real tab click", () => {
    vi.useFakeTimers();
    try {
      const onEvent = vi.fn<TabStripOnEvent>();
      render(
        <TabStrip
          component={tabStripComponent()}
          state={{
            activeTabId: "ag-1",
            tabs: [
              { id: "ag-1", label: "Chat", kind: "agent" },
              {
                id: "ed-1",
                label: "App.tsx",
                kind: "editor",
                editor: { filePath: "/repo/App.tsx" },
              },
            ],
          }}
          onEvent={onEvent}
        />,
      );
      const chat = screen.getByText("Chat").closest('[role="tab"]')!;
      const editor = screen.getByText("App.tsx").closest('[role="tab"]')!;
      setRect(chat, { left: 0, width: 100 });

      fireEvent.pointerDown(editor, { button: 0, clientX: 120, clientY: 8 });
      fireEvent.pointerMove(document, { clientX: 10, clientY: 8 });
      fireEvent.pointerUp(document, { clientX: 10, clientY: 8 });
      expect(onEvent).toHaveBeenCalledWith("reorder", {
        tabId: "ed-1",
        toIndex: 0,
      });

      onEvent.mockClear();
      vi.runOnlyPendingTimers();
      fireEvent.click(chat);

      expect(onEvent).toHaveBeenCalledWith("select", { tabId: "ag-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the overview and new-tab controls out of drag reordering", () => {
    renderTabStrip();
    const overviewPill = screen
      .getAllByRole("tab")
      .find((el) => el.textContent?.includes("overview"))!;
    const realTab = screen.getByText("Tab 1").closest('[role="tab"]')!;
    const newButton = screen.getByRole("button", { name: "New Tab" });

    expect(realTab.getAttribute("draggable")).toBe("false");
    expect(realTab.getAttribute("data-tab-id")).toBe("tab-1");
    expect(overviewPill.getAttribute("draggable")).not.toBe("true");
    expect(overviewPill.getAttribute("data-tab-id")).toBeNull();
    expect(newButton.getAttribute("draggable")).not.toBe("true");
    expect(newButton.getAttribute("data-tab-id")).toBeNull();
  });

  it("renders a file-type icon for editor tabs but not agent tabs", () => {
    render(
      <TabStrip
        component={tabStripComponent()}
        state={{
          activeTabId: "ed-1",
          tabs: [
            { id: "ag-1", label: "Chat", kind: "agent" },
            {
              id: "ed-1",
              label: "Cargo.toml",
              kind: "editor",
              editor: { filePath: "/repo/Cargo.toml" },
            },
          ],
        }}
        onEvent={vi.fn<TabStripOnEvent>()}
      />,
    );
    const editorTab = screen.getByText("Cargo.toml").closest('[role="tab"]')!;
    expect(editorTab.querySelector("img.a2ui-tab-icon")).not.toBeNull();
    const agentTab = screen.getByText("Chat").closest('[role="tab"]')!;
    expect(agentTab.querySelector("img.a2ui-tab-icon")).toBeNull();
  });
});
