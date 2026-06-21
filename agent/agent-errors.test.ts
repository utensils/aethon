import { describe, expect, it } from "vitest";
import {
  extractAgentEndError,
  formatAgentErrorMessage,
  isContextLengthExceededError,
  isRetryableAgentEndError,
  isUsageLimitError,
} from "./agent-errors";

// Real Codex usage-limit 429 payload (truncated headers) — the raw string
// the agent surfaces when an account hits its quota.
const CODEX_USAGE_LIMIT_RAW =
  'Codex error: {"type":"error","error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1781838269,"resets_in_seconds":1621},"status_code":429,"headers":{"X-Codex-Primary-Used-Percent":"100"}}';

const CODEX_CONTEXT_LENGTH_RAW =
  'Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}';

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

describe("isRetryableAgentEndError", () => {
  it("classifies transient websocket closures as retryable", () => {
    expect(
      isRetryableAgentEndError("WebSocket closed 1006 Connection ended"),
    ).toBe(true);
  });

  it("does not classify account/configuration errors as retryable", () => {
    expect(
      isRetryableAgentEndError(
        "Your credit balance is too low to access the Anthropic API.",
      ),
    ).toBe(false);
  });

  it("does NOT retry a usage-limit 429 even though it carries '429'", () => {
    // Without the usage-limit guard the "429" substring would make this
    // look retryable and burn the whole retry budget on a dead quota.
    expect(isRetryableAgentEndError(CODEX_USAGE_LIMIT_RAW)).toBe(false);
  });
});

describe("isContextLengthExceededError", () => {
  it("detects Codex context_length_exceeded payloads", () => {
    expect(isContextLengthExceededError(CODEX_CONTEXT_LENGTH_RAW)).toBe(true);
  });

  it("detects the human-readable Codex context-window phrasing", () => {
    expect(
      isContextLengthExceededError(
        "Your input exceeds the context window of this model.",
      ),
    ).toBe(true);
  });

  it("does not confuse usage-limit errors with context overflow", () => {
    expect(isContextLengthExceededError(CODEX_USAGE_LIMIT_RAW)).toBe(false);
  });
});

describe("isUsageLimitError", () => {
  it("detects the Codex usage_limit_reached payload", () => {
    expect(isUsageLimitError(CODEX_USAGE_LIMIT_RAW)).toBe(true);
  });

  it("detects the human-readable phrasing", () => {
    expect(isUsageLimitError("The usage limit has been reached")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isUsageLimitError("WebSocket closed 1006")).toBe(false);
  });
});

describe("formatAgentErrorMessage", () => {
  it("rewrites a raw usage-limit 429 into a clean, actionable sentence", () => {
    const out = formatAgentErrorMessage(CODEX_USAGE_LIMIT_RAW);
    expect(out).toContain("Usage limit reached for this account");
    expect(out).toContain("(pro)");
    expect(out).toContain("Resets in 27m"); // 1621s → 27m
    expect(out).toContain("Cmd+Shift+A");
    // None of the raw JSON / header noise should leak through.
    expect(out).not.toContain("X-Codex");
    expect(out).not.toContain("status_code");
  });

  it("rewrites a raw Codex context-length payload into a clean recovery message", () => {
    const out = formatAgentErrorMessage(CODEX_CONTEXT_LENGTH_RAW);
    expect(out).toBe(
      "Context window exceeded. Compacting context and resuming automatically.",
    );
    expect(out).not.toContain("context_length_exceeded");
    expect(out).not.toContain("sequence_number");
  });

  it("passes unrelated non-usage-limit errors through unchanged", () => {
    const raw = "Your credit balance is too low to access the Anthropic API.";
    expect(formatAgentErrorMessage(raw)).toBe(raw);
  });

  it("omits the reset clause when resets_in_seconds is absent", () => {
    const out = formatAgentErrorMessage(
      '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
    );
    expect(out).toContain("Usage limit reached for this account");
    expect(out).not.toContain("Resets in");
  });
});
