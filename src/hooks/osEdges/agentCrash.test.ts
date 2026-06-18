import { describe, expect, it } from "vitest";
import {
  selectAgentCrashDiagnostic,
  summarizeRunningToolCrash,
} from "./agentCrash";
import type { Tab } from "../../types/tab";

describe("agent crash diagnostics", () => {
  it("prefers actionable crash lines over runtime version banners", () => {
    expect(
      selectAgentCrashDiagnostic(
        [
          "2026-06-18T14:34:20.000Z ERROR subagent: timed out after 600s",
          "Bun v1.3.14 (macOS arm64)",
        ],
        "tab:abc",
      ),
    ).toContain("timed out after 600s");
  });

  it("falls back when the tail only contains a runtime banner", () => {
    expect(
      selectAgentCrashDiagnostic(["Bun v1.3.14 (macOS arm64)"], "tab:abc"),
    ).toBe("Agent worker exited unexpectedly (tab:abc).");
  });

  it("summarizes the running task when a worker exits mid-tool", () => {
    const tabs = [
      {
        id: "tab-1",
        kind: "agent",
        messages: [
          {
            id: "m1",
            role: "agent",
            a2ui: {
              components: [
                {
                  id: "tool-1",
                  type: "tool-card",
                  props: {
                    toolName: "task_batch",
                    description: "kimi, glm-5-2 · inline",
                    startedAt: 1000,
                  },
                },
              ],
            },
          },
        ],
      },
    ] as unknown as Tab[];

    expect(summarizeRunningToolCrash(tabs, "tab-1")).toBe(
      "task_batch kimi, glm-5-2 · inline",
    );
    expect(summarizeRunningToolCrash(tabs)).toBeUndefined();
  });
});
