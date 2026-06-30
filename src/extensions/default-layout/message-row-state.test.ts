import { describe, expect, it } from "vitest";
import { fallbackAgentActivityForTab, tabIsRunning } from "./message-row-state";

describe("tabIsRunning", () => {
  it("uses global waiting only for untabbed callers", () => {
    expect(tabIsRunning({ waiting: true })).toBe(true);
    expect(tabIsRunning({ waiting: false })).toBe(false);
  });

  it("uses tab-scoped running state across workspace switches", () => {
    expect(
      tabIsRunning(
        {
          waiting: false,
          activeTabId: "other-tab",
          agentRunningTabs: { "tab-1": true },
        },
        "tab-1",
      ),
    ).toBe(true);
  });

  it("does not smear global waiting onto another tab", () => {
    expect(
      tabIsRunning(
        {
          waiting: true,
          activeTabId: "active-tab",
          agentRunningTabs: {},
        },
        "other-tab",
      ),
    ).toBe(false);
  });

  it("uses global waiting for the active tab when the running map has not caught up", () => {
    expect(
      tabIsRunning(
        {
          waiting: true,
          activeTabId: "active-tab",
          agentRunningTabs: {},
        },
        "active-tab",
      ),
    ).toBe(true);
  });

  it("keeps legacy waiting-only state working when no active tab id is known", () => {
    expect(
      tabIsRunning(
        {
          waiting: true,
          agentRunningTabs: {},
        },
        "tab-1",
      ),
    ).toBe(true);
  });
});

describe("fallbackAgentActivityForTab", () => {
  it("uses writing copy while the latest visible message is streamed agent prose", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          { role: "agent", text: "partial answer" },
        ],
      ),
    ).toEqual({
      label: "Writing response",
      detail: "Streaming the answer",
    });
  });

  it("uses generic working copy before visible agent prose exists", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [{ role: "user", text: "start" }],
      ),
    ).toEqual({
      label: "Thinking through next step",
      detail: "Waiting for the next update",
    });
  });

  it("does not derive fallback activity from hidden thinking-only messages", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          { role: "agent", thinking: "internal chain" },
        ],
        { thinkingVisibility: "hide" },
      ),
    ).toBeNull();
  });

  it("ignores whitespace-only thinking when choosing fallback activity", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          { role: "agent", thinking: "   \n\t  " },
        ],
        { thinkingVisibility: "hide" },
      ),
    ).toEqual({
      label: "Thinking through next step",
      detail: "Waiting for the next update",
    });
  });

  it("does not derive fallback activity from hidden embedded thinking-only text", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          { role: "agent", text: "<thinking>internal chain</thinking>" },
        ],
        { thinkingVisibility: "hide" },
      ),
    ).toBeNull();
  });

  it("uses writing copy for thinking-only messages when thinking is visible", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          { role: "agent", thinking: "visible reasoning" },
        ],
        { thinkingVisibility: "show" },
      ),
    ).toEqual({
      label: "Writing response",
      detail: "Streaming the answer",
    });
  });

  it("keeps writing copy when visible text surrounds hidden embedded thinking", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [
          { role: "user", text: "start" },
          {
            role: "agent",
            text: "<thinking>internal chain</thinking>visible answer",
          },
        ],
        { thinkingVisibility: "hide" },
      ),
    ).toEqual({
      label: "Writing response",
      detail: "Streaming the answer",
    });
  });

  it("can provide generic status for footer-only empty transcripts", () => {
    expect(
      fallbackAgentActivityForTab(
        { waiting: true, activeTabId: "tab-1" },
        "tab-1",
        [],
        { allowEmpty: true },
      ),
    ).toEqual({
      label: "Thinking through next step",
      detail: "Waiting for the next update",
    });
  });
});
