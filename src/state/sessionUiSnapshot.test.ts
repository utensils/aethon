// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { makeEmptyTab } from "../types/tab";
import {
  loadSessionUiSnapshot,
  saveSessionUiSnapshot,
} from "./sessionUiSnapshot";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("sessionUiSnapshot", () => {
  it("round-trips open tabs, active tab, and chrome state", () => {
    const tabA = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    const tabB = {
      ...makeEmptyTab("tab-b", "B"),
      canvas: { type: "card", children: [] },
    };

    saveSessionUiSnapshot({
      tabs: [tabA, tabB],
      activeTabId: "tab-b",
      layout: {
        sidebarVisible: true,
        columns: "300px minmax(0,1fr)",
      },
      terminal: { open: true },
      terminalPanel: { activeSubId: "agent-bash", height: 240 },
      projectModels: { "project-1": "anthropic/claude-opus-4-7" },
    });

    expect(loadSessionUiSnapshot()).toMatchObject({
      activeTabId: "tab-b",
      tabs: [
        { id: "tab-a", label: "A", messages: [{ text: "hi" }] },
        { id: "tab-b", label: "B", canvas: { type: "card" } },
      ],
      layout: { sidebarVisible: true, columns: "300px minmax(0,1fr)" },
      terminal: { open: true },
      terminalPanel: { activeSubId: "agent-bash", height: 240 },
      projectModels: { "project-1": "anthropic/claude-opus-4-7" },
    });
  });

  it("falls back to the first tab when the active id is stale", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "missing",
    });

    expect(loadSessionUiSnapshot()?.activeTabId).toBe("tab-a");
  });

  it("drops shell tabs from the reload snapshot", () => {
    saveSessionUiSnapshot({
      tabs: [
        {
          ...makeEmptyTab("agent", "Agent"),
          messages: [{ id: "m1", role: "user", text: "hi" }],
        },
        makeEmptyTab("shell", "Shell", null, "shell"),
      ],
      activeTabId: "shell",
    });

    const restored = loadSessionUiSnapshot();
    expect(restored?.tabs.map((t) => t.id)).toEqual(["agent"]);
    expect(restored?.activeTabId).toBe("agent");
  });

  it("does not persist blank empty new tabs", () => {
    saveSessionUiSnapshot({
      tabs: [
        makeEmptyTab("blank", "Tab 1"),
        {
          ...makeEmptyTab("active-chat", "Tell me about this app"),
          messages: [{ id: "m1", role: "user", text: "Tell me about this app" }],
        },
      ],
      activeTabId: "blank",
    });

    const restored = loadSessionUiSnapshot();
    expect(restored?.tabs.map((t) => t.id)).toEqual(["active-chat"]);
    expect(restored?.activeTabId).toBe("active-chat");
  });

  it("does not persist extension-added layout columns or areas", () => {
    const tab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [{ id: "m1", role: "user" as const, text: "hi" }],
    };
    saveSessionUiSnapshot({
      tabs: [tab],
      activeTabId: "tab-a",
      layout: {
        sidebarVisible: true,
        columns: "256px minmax(0,1fr) 360px",
        areas: [
          "sidebar header header",
          "sidebar canvas gallery",
          "status status status",
        ],
      },
    });

    expect(loadSessionUiSnapshot()?.layout).toEqual({
      sidebarVisible: true,
      columns: "256px minmax(0,1fr)",
    });
  });
});
