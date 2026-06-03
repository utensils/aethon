import { describe, expect, it } from "vitest";
import { makeEmptyTab } from "../types/tab";
import { isAgentTabBusy } from "./agentBusy";

describe("isAgentTabBusy", () => {
  it("treats queuedMessages as authoritative when including client queue", () => {
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      queueCount: 0,
      queuedMessages: [{ id: "q1", content: "queued" }],
    };

    expect(isAgentTabBusy(tab, { includeQueue: true })).toBe(true);
  });
});
