import { describe, expect, it } from "vitest";
import { createdAtFromAgentStderr, tabIdFromAgentStderr } from "./agentStderr";

describe("agent stderr helpers", () => {
  it("extracts tab ids from bridge turn logs", () => {
    expect(
      tabIdFromAgentStderr(
        "2026-06-01T15:57:41.305Z WARN turn: end model=openai-codex/gpt-5.5 tabId=d42627d5-5bd1-485d-848c-ea996250506a durationMs=51994 stopReason=error",
      ),
    ).toBe("d42627d5-5bd1-485d-848c-ea996250506a");
  });

  it("extracts timestamps from bridge log lines", () => {
    expect(
      createdAtFromAgentStderr(
        "2026-06-01T15:57:41.305Z WARN turn: end model=openai-codex/gpt-5.5 tabId=tab-1",
      ),
    ).toBe(Date.parse("2026-06-01T15:57:41.305Z"));
  });
});
