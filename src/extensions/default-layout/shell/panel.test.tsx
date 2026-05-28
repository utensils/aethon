// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERVIEW_TAB_ID } from "../../../types/tab";
import type { A2UIComponent } from "../../../types/a2ui";

// Mount-heavy children — Terminal pulls in xterm and ShellCanvas wires
// PTY events. The panel chrome (sub-tab pills, empty placeholder) is
// what this test cares about, so mock the children to neutral stubs.
vi.mock("../terminal", () => ({
  Terminal: () => <div data-testid="stub-terminal" />,
}));
vi.mock("./canvas", () => ({
  ShellCanvas: ({
    component,
  }: {
    component: { props: { tabId: string } };
  }) => <div data-testid="stub-shell" data-tab-id={component.props.tabId} />,
}));

import { TerminalPanel } from "./panel";

afterEach(() => cleanup());

function panelComponent(): A2UIComponent {
  return {
    id: "terminal-panel",
    type: "terminal-panel",
    props: { fontSize: 13 },
  };
}

describe("TerminalPanel", () => {
  it("hides the Agent bash sub-tab when the overview owns the canvas", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: OVERVIEW_TAB_ID,
          tabs: [],
          terminalPanel: { activeSubId: "agent-bash" },
        }}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.queryByText("Agent bash")).toBeNull();
    // Body falls through to the empty-state placeholder.
    expect(screen.getByRole("status").textContent).toMatch(/No shell open/);
  });

  it("shows the Agent bash sub-tab when an agent tab is active", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", kind: "agent", label: "Tab 1" }],
          terminalPanel: { activeSubId: "agent-bash" },
        }}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.getByText("Agent bash")).toBeTruthy();
    expect(screen.getByTestId("stub-terminal")).toBeTruthy();
  });

  it("activates the first real shell sub-tab when on overview with shells present", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: OVERVIEW_TAB_ID,
          tabs: [
            {
              id: "sh-1",
              kind: "shell",
              label: "Shell 1",
              shell: { shellState: "running" },
            },
          ],
          terminalPanel: { activeSubId: "agent-bash" },
        }}
        onEvent={vi.fn()}
      />,
    );
    // Agent bash hidden, shell pill rendered.
    expect(screen.queryByText("Agent bash")).toBeNull();
    expect(screen.getByText("Shell 1")).toBeTruthy();
    const shell = screen.getByTestId("stub-shell");
    expect(shell.getAttribute("data-tab-id")).toBe("sh-1");
  });

  it("keeps the requested shell as active even when overview is on", () => {
    // User had Shell 2 selected before clicking the overview pill —
    // their selection should survive the canvas swap.
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: OVERVIEW_TAB_ID,
          tabs: [
            { id: "sh-1", kind: "shell", label: "Shell 1" },
            { id: "sh-2", kind: "shell", label: "Shell 2" },
          ],
          terminalPanel: { activeSubId: "sh-2" },
        }}
        onEvent={vi.fn()}
      />,
    );
    const shell = screen.getByTestId("stub-shell");
    expect(shell.getAttribute("data-tab-id")).toBe("sh-2");
  });

  it("always renders the + new-shell button", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: OVERVIEW_TAB_ID,
          tabs: [],
          terminalPanel: { activeSubId: "agent-bash" },
        }}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("New shell")).toBeTruthy();
  });
});
