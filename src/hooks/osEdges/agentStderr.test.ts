import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createdAtFromAgentStderr,
  subscribeAgentStderr,
  tabIdFromAgentStderr,
} from "./agentStderr";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("agent stderr helpers", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    clearTauriMocks();
  });

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

  it("mirrors and persists warning lines with their tab and timestamp", () => {
    const appendMessage = vi.fn();
    const persistLocalChatMessage = vi.fn();
    subscribeAgentStderr({ appendMessage, persistLocalChatMessage });

    const line =
      "2026-06-02T13:36:55.343Z WARN devshell: env_for_path(/repo) failed: timeout tabId=tab-1";
    expect(harness.fireEvent("agent-stderr", line)).toBe(1);

    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(persistLocalChatMessage).toHaveBeenCalledTimes(1);
    const [message, tabId] = appendMessage.mock.calls[0];
    expect(tabId).toBe("tab-1");
    expect(message).toMatchObject({
      role: "system",
      text: `[agent stderr] ${line}`,
      createdAt: Date.parse("2026-06-02T13:36:55.343Z"),
    });
    expect(persistLocalChatMessage).toHaveBeenCalledWith(message, "tab-1");
  });
});
