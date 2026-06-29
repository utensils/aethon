import { describe, expect, it } from "vitest";
import { makeEmptyTab, type Tab } from "../types/tab";
import { buildTraySessionItems } from "./traySessions";

function agent(id: string, label: string, patch: Partial<Tab> = {}): Tab {
  return {
    ...makeEmptyTab(id, label),
    cwd: `/repo/${label.toLowerCase().replace(/\s+/g, "-")}`,
    ...patch,
  };
}

describe("buildTraySessionItems", () => {
  it("includes visible and hidden agent sessions only", () => {
    const visible = agent("a1", "Visible");
    const hidden = agent("a2", "Hidden");
    const shell = makeEmptyTab("sh1", "Shell", null, "shell");
    const editor = makeEmptyTab("ed1", "Editor", null, "editor");

    expect(
      buildTraySessionItems({
        tabs: [visible, shell],
        persistedTabBuckets: {
          "p1::workspace::w1": { tabs: [hidden, editor], activeTabId: "a2" },
        },
      }).map((item) => item.id),
    ).toEqual(["a2", "a1"]);
  });

  it("reflects active, running, attention, and queued state", () => {
    const current = agent("current", "Current", {
      queuedMessages: [{ id: "q1", content: "queued" }],
      queueCount: 1,
    });
    const running = agent("running", "Running");
    const attention = agent("attention", "Attention");

    const items = buildTraySessionItems({
      activeTabId: "current",
      tabs: [attention, running, current],
      agentRunningTabs: { running: true },
      agentAttentionTabs: { attention: true },
    });

    expect(items).toMatchObject([
      { id: "current", active: true, queued_count: 1 },
      { id: "running", running: true },
      { id: "attention", needs_attention: true },
    ]);
  });

  it("uses the first user message for untitled tabs", () => {
    const tab = agent("a1", "Tab 1", {
      messages: [
        {
          id: "m1",
          role: "user",
          text: "  Build the tray menu  ",
        },
      ],
    });

    expect(buildTraySessionItems({ tabs: [tab] })[0]).toMatchObject({
      label: "Build the tray menu",
      detail: "tab-1",
    });
  });
});
