import { describe, expect, it } from "vitest";
import { extractAgentEndError } from "./agent-errors";

describe("extractAgentEndError", () => {
  it("returns undefined for an empty or missing list", () => {
    expect(extractAgentEndError(undefined)).toBeUndefined();
    expect(extractAgentEndError([])).toBeUndefined();
  });

  it("ignores successful assistant messages", () => {
    expect(
      extractAgentEndError([
        { role: "assistant", stopReason: "stop", errorMessage: undefined },
      ]),
    ).toBeUndefined();
  });

  it("ignores aborted runs (deliberate user action, not an error)", () => {
    expect(
      extractAgentEndError([
        { role: "assistant", stopReason: "aborted", errorMessage: "user pressed Cmd+." },
      ]),
    ).toBeUndefined();
  });

  it("returns the errorMessage when an assistant turn ended with stopReason=error", () => {
    const out = extractAgentEndError([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      },
    ]);
    expect(out).toContain("credit balance is too low");
  });

  it("ignores stopReason=error messages with empty errorMessage strings", () => {
    expect(
      extractAgentEndError([
        { role: "assistant", stopReason: "error", errorMessage: "" },
      ]),
    ).toBeUndefined();
  });

  it("scans past non-assistant messages to find the failed turn", () => {
    expect(
      extractAgentEndError([
        { role: "user" },
        { role: "toolResult" },
        { role: "assistant", stopReason: "error", errorMessage: "boom" },
      ]),
    ).toBe("boom");
  });
});
