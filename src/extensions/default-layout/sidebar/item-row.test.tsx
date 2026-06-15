// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarItem } from "../../../types/a2ui";
import { ItemRow } from "./item-row";

function renderItemRow(
  item: SidebarItem,
  disclosure?: "expanded" | "collapsed",
) {
  return render(
    <ul>
      <ItemRow
        item={item}
        monoItems={false}
        sectionId="projects"
        componentId="sidebar"
        onEvent={vi.fn()}
        renderChildWithState={vi.fn()}
        state={{}}
        index={0}
        disclosure={disclosure}
        stacked
      />
    </ul>,
  );
}

afterEach(() => cleanup());

describe("ItemRow agent activity", () => {
  it("shows project rollup activity while expanded when a workspace agent is running", () => {
    renderItemRow(
      {
        id: "p1",
        label: "aethon",
        agent: { status: "none", runningCount: 0 },
        agentRollup: { status: "running", runningCount: 1 },
      },
      "expanded",
    );

    expect(screen.getByLabelText("Agent running")).toBeTruthy();
  });

  it("keeps expanded project rows dot-free for idle workspace-only sessions", () => {
    renderItemRow(
      {
        id: "p1",
        label: "aethon",
        agent: { status: "none", runningCount: 0 },
        agentRollup: { status: "idle-with-session", runningCount: 0 },
      },
      "expanded",
    );

    expect(screen.queryByLabelText("Agent session idle")).toBeNull();
  });
});
