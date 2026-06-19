import { describe, expect, it, vi } from "vitest";
import { fetchCodexUsage, parseCodexUsageBody } from "./codex-usage";

describe("parseCodexUsageBody", () => {
  it("parses the /backend-api/codex/usage shape (primary_window + limit_reached)", () => {
    const out = parseCodexUsageBody({
      email: "user@example.com",
      plan_type: "pro",
      rate_limit: {
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18000,
          reset_at: 1781838270,
        },
        secondary_window: {
          used_percent: 35,
          limit_window_seconds: 604800,
          reset_at: 1782397309,
        },
      },
      credits: { has_credits: false, unlimited: false, balance: 0 },
    });
    expect(out.email).toBe("user@example.com");
    expect(out.planType).toBe("pro");
    expect(out.limitReached).toBe(true);
    expect(out.primary).toEqual({
      usedPercent: 100,
      windowDurationMins: 300, // 18000s → 300m (5-hour)
      resetsAt: 1781838270,
    });
    expect(out.secondary?.usedPercent).toBe(35);
    expect(out.secondary?.windowDurationMins).toBe(10080); // weekly
    expect(out.credits).toEqual({
      balance: "0",
      hasCredits: false,
      unlimited: false,
    });
  });

  it("parses the app-server rate_limits shape (window_minutes + reached_type)", () => {
    const out = parseCodexUsageBody({
      rate_limits: {
        plan_type: "pro",
        rate_limit_reached_type: "rate_limit_reached",
        primary: {
          used_percent: 96,
          window_minutes: 300,
          resets_at: 1780339066,
        },
        secondary: { used_percent: 7, window_minutes: 10080 },
      },
    });
    expect(out.planType).toBe("pro");
    expect(out.limitReached).toBe(true); // non-null reached_type
    expect(out.primary).toEqual({
      usedPercent: 96,
      windowDurationMins: 300,
      resetsAt: 1780339066,
    });
    expect(out.secondary?.usedPercent).toBe(7);
  });

  it("treats a null rate_limit_reached_type as not limited", () => {
    const out = parseCodexUsageBody({
      rate_limits: {
        rate_limit_reached_type: null,
        primary: { used_percent: 10, window_minutes: 300 },
      },
    });
    expect(out.limitReached).toBe(false);
  });

  it("returns an empty object for a bodyless / unknown payload", () => {
    expect(parseCodexUsageBody({})).toEqual({});
  });
});

describe("fetchCodexUsage", () => {
  it("throws when the account cannot produce an access token", async () => {
    const probe = vi.fn(() => Promise.resolve(undefined));
    await expect(fetchCodexUsage(probe)).rejects.toThrow(/no access token/);
  });
});
