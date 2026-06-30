import { describe, expect, it } from "vitest";
import { tabIsRunning } from "./message-row-state";

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
