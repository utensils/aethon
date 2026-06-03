// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { resolveActiveSubId, resolveActiveSubIdFromState } from "./panel-helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("resolveActiveSubId", () => {
  it("returns the requested shell when it still exists", () => {
    expect(
      resolveActiveSubId({
        requestedActiveId: "sh-1",
        shellTabIds: ["sh-1", "sh-2"],
        showAgentBash: true,
      }),
    ).toBe("sh-1");
  });

  it("returns agent-bash when the requested id is the agent-bash sentinel and it's allowed", () => {
    expect(
      resolveActiveSubId({
        requestedActiveId: "agent-bash",
        shellTabIds: [],
        showAgentBash: true,
      }),
    ).toBe("agent-bash");
  });

  it("clamps to the first shell when agent-bash is hidden and the requested id is stale", () => {
    // The Codex finding: overview owns the canvas, panel state still
    // reads "agent-bash" but the panel renders a real shell instead.
    // Both the panel and Cmd+W must agree on the resolved id.
    expect(
      resolveActiveSubId({
        requestedActiveId: "agent-bash",
        shellTabIds: ["sh-1", "sh-2"],
        showAgentBash: false,
      }),
    ).toBe("sh-1");
  });

  it("returns null when nothing can be displayed", () => {
    expect(
      resolveActiveSubId({
        requestedActiveId: "agent-bash",
        shellTabIds: [],
        showAgentBash: false,
      }),
    ).toBeNull();
  });

  it("falls back to first shell when the requested id no longer maps to a tab", () => {
    expect(
      resolveActiveSubId({
        requestedActiveId: "sh-zombie",
        shellTabIds: ["sh-1"],
        showAgentBash: false,
      }),
    ).toBe("sh-1");
  });
});

describe("resolveActiveSubIdFromState", () => {
  it("matches what the panel renders on overview", () => {
    // Reproduces the Codex regression scenario: overview pseudo-tab
    // active, panel state still pointing at agent-bash. Cmd+W must
    // resolve the same shell the panel paints.
    const state = {
      activeTabId: "__overview__",
      tabs: [
        { id: "sh-1", kind: "shell", label: "Shell 1" },
      ],
      terminalPanel: { activeSubId: "agent-bash" },
    } as Record<string, unknown>;
    expect(resolveActiveSubIdFromState(state)).toBe("sh-1");
  });

  it("treats a shell active id like overview instead of showing agent-bash", () => {
    const state = {
      activeTabId: "sh-1",
      tabs: [
        { id: "sh-1", kind: "shell", label: "Shell 1" },
      ],
      terminalPanel: { activeSubId: "agent-bash" },
    } as Record<string, unknown>;
    expect(resolveActiveSubIdFromState(state)).toBe("sh-1");
  });

  it("returns agent-bash when an agent session owns the canvas", () => {
    const state = {
      activeTabId: "agent-1",
      tabs: [{ id: "agent-1", kind: "agent", label: "Tab 1" }],
      terminalPanel: { activeSubId: "agent-bash" },
    } as Record<string, unknown>;
    expect(resolveActiveSubIdFromState(state)).toBe("agent-bash");
  });
});

function createDataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: vi.fn((type: string) => values.get(type) ?? ""),
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

  it("hides Agent bash when a shell tab id is active", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: "sh-1",
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

    expect(screen.queryByText("Agent bash")).toBeNull();
    expect(screen.getByText("Shell 1")).toBeTruthy();
    expect(screen.getByTestId("stub-shell").getAttribute("data-tab-id")).toBe(
      "sh-1",
    );
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

  it("emits reorder-sub-tab when an interactive shell tab is dragged", () => {
    const onEvent = vi.fn();
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: OVERVIEW_TAB_ID,
          tabs: [
            { id: "sh-1", kind: "shell", label: "Shell 1" },
            { id: "sh-2", kind: "shell", label: "Shell 2" },
          ],
          terminalPanel: { activeSubId: "sh-1" },
        }}
        onEvent={onEvent}
      />,
    );
    const shell1 = screen.getByText("Shell 1").closest('[role="tab"]')!;
    const shell2 = screen.getByText("Shell 2").closest('[role="tab"]')!;
    setRect(shell1, { left: 0, width: 100 });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(shell2, { dataTransfer });
    fireEvent.dragOver(shell1, { clientX: 10, dataTransfer });
    fireEvent.drop(shell1, { clientX: 10, dataTransfer });

    expect(onEvent).toHaveBeenCalledWith("reorder-sub-tab", {
      subTabId: "sh-2",
      toIndex: 0,
    });
  });

  it("keeps Agent bash pinned and only shell tabs draggable", () => {
    render(
      <TerminalPanel
        component={panelComponent()}
        state={{
          activeTabId: "tab-1",
          tabs: [
            { id: "tab-1", kind: "agent", label: "Tab 1" },
            { id: "sh-1", kind: "shell", label: "Shell 1" },
          ],
          terminalPanel: { activeSubId: "agent-bash" },
        }}
        onEvent={vi.fn()}
      />,
    );
    const agentBash = screen.getByText("Agent bash").closest('[role="tab"]')!;
    const shell = screen.getByText("Shell 1").closest('[role="tab"]')!;

    expect(agentBash.getAttribute("draggable")).toBe("false");
    expect(shell.getAttribute("draggable")).toBe("true");
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
