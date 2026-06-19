import { describe, expect, it, vi } from "vitest";
import { handleAuthProfileUsage } from "./authProfileUsage";
import type { BridgeMessageContext } from "./types";

function makeCtx() {
  let captured: Record<string, unknown> | undefined;
  const setState = vi.fn((updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
    captured = updater({
      authProfiles: {
        profiles: [{ id: "p1", providerId: "openai-codex", label: "Test", kind: "oauth", createdAt: 0, updatedAt: 0 }],
        defaultByProvider: {},
        providers: [],
        activeByTab: {},
      },
    });
  });
  return { setState, captured: () => captured } as unknown as {
    setState: typeof setState;
    captured: () => Record<string, unknown> | undefined;
  } & { ctx: BridgeMessageContext };
}

describe("handleAuthProfileUsage", () => {
  it("stores usage data keyed by profileId", () => {
    const { setState, captured } = makeCtx();
    handleAuthProfileUsage(
      {
        type: "auth_profile_usage",
        profileId: "p1",
        email: "user@example.com",
        planType: "pro",
        primary: { usedPercent: 42, resetsAt: 999, windowDurationMins: 300 },
      },
      { setState } as unknown as BridgeMessageContext,
    );
    expect(setState).toHaveBeenCalledOnce();
    const state = captured();
    const auth = state?.authProfiles as Record<string, unknown>;
    const usage = auth.usage as Record<string, Record<string, unknown>>;
    expect(usage.p1.email).toBe("user@example.com");
    expect(usage.p1.planType).toBe("pro");
    const primary = usage.p1.primary as { usedPercent: number };
    expect(primary.usedPercent).toBe(42);
  });

  it("ignores messages without profileId", () => {
    const { setState } = makeCtx();
    handleAuthProfileUsage(
      { type: "auth_profile_usage" },
      { setState } as unknown as BridgeMessageContext,
    );
    expect(setState).not.toHaveBeenCalled();
  });

  it("stores error messages", () => {
    const { setState, captured } = makeCtx();
    handleAuthProfileUsage(
      {
        type: "auth_profile_usage",
        profileId: "p1",
        error: "rate_limits request failed: 401 Unauthorized",
      },
      { setState } as unknown as BridgeMessageContext,
    );
    const state = captured();
    const auth = state?.authProfiles as Record<string, unknown>;
    const usage = auth.usage as Record<string, Record<string, unknown>>;
    expect(usage.p1.error).toBe("rate_limits request failed: 401 Unauthorized");
  });
});
