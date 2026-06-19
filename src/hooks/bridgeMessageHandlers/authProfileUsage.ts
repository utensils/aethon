import type { AuthProfileUsage, AuthProfilesUiState } from "../../auth-profiles";
import type { BridgeMessageHandler } from "./types";

export const handleAuthProfileUsage: BridgeMessageHandler = (message, ctx) => {
  const profileId =
    typeof message.profileId === "string" ? message.profileId : undefined;
  if (!profileId) return;

  const usage: AuthProfileUsage = {
    email: typeof message.email === "string" ? message.email : undefined,
    accountId:
      typeof message.accountId === "string" ? message.accountId : undefined,
    planType:
      typeof message.planType === "string" ? message.planType : undefined,
    limitReached:
      typeof message.limitReached === "boolean"
        ? message.limitReached
        : undefined,
    primary: isUsageWindow(message.primary) ? message.primary : undefined,
    secondary: isUsageWindow(message.secondary) ? message.secondary : undefined,
    credits: isCredits(message.credits) ? message.credits : undefined,
    error: typeof message.error === "string" ? message.error : undefined,
    fetchedAt: Date.now(),
  };

  ctx.setState((prev) => {
    const current =
      (prev.authProfiles as Partial<AuthProfilesUiState> | undefined) ?? {};
    return {
      ...prev,
      authProfiles: {
        profiles: [],
        defaultByProvider: {},
        providers: [],
        activeByTab: {},
        ...current,
        usage: { ...(current.usage ?? {}), [profileId]: usage },
      },
    };
  });
};

function isUsageWindow(
  v: unknown,
): v is { usedPercent: number; resetsAt?: number; windowDurationMins?: number } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.usedPercent === "number";
}

function isCredits(
  v: unknown,
): v is { balance?: string; hasCredits?: boolean; unlimited?: boolean } {
  return !!v && typeof v === "object";
}
