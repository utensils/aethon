import { readFileSync, writeFileSync } from "node:fs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const RATE_LIMITS_URL = "https://chatgpt.com/backend-api/codex/rate_limits";

export interface CodexUsageWindow {
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
}

export interface CodexUsageResult {
  email?: string;
  planType?: string;
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
  credits?: { balance?: string; hasCredits?: boolean; unlimited?: boolean };
}

interface TokenResult {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  const segment = parts[1]!;
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function extractEmail(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  if (typeof payload.email === "string") return payload.email;
  const auth = payload["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  if (typeof auth?.email === "string") return auth.email;
  return undefined;
}

function extractAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function refreshToken(refreshToken: string): Promise<TokenResult> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`token refresh failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error("token refresh response missing required fields");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in as number) * 1000,
    accountId: extractAccountId(json.access_token),
    idToken:
      typeof json.id_token === "string" ? json.id_token : undefined,
  };
}

function parseWindow(value: unknown): CodexUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.usedPercent !== "number") return undefined;
  const w: CodexUsageWindow = { usedPercent: rec.usedPercent };
  if (typeof rec.resetsAt === "number") w.resetsAt = rec.resetsAt;
  if (typeof rec.windowDurationMins === "number") {
    w.windowDurationMins = rec.windowDurationMins;
  }
  return w;
}

export async function fetchCodexProfileUsage(
  profileAuthPath: string,
  providerId: string,
): Promise<CodexUsageResult> {
  const stored = JSON.parse(readFileSync(profileAuthPath, "utf8")) as Record<
    string,
    unknown
  >;
  const entry = stored[providerId];
  if (!entry || typeof entry !== "object") {
    throw new Error("no stored credentials for provider");
  }
  const creds = entry as Record<string, unknown>;
  const storedRefresh =
    typeof creds.refresh === "string"
      ? creds.refresh
      : typeof creds.refresh_token === "string"
        ? creds.refresh_token
        : undefined;
  if (!storedRefresh) {
    throw new Error("no refresh token stored");
  }

  const tokens = await refreshToken(storedRefresh);

  // Persist the refreshed tokens back to the profile's auth.json
  const updated = {
    ...stored,
    [providerId]: {
      ...creds,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    },
  };
  writeFileSync(profileAuthPath, JSON.stringify(updated, null, 2));

  const email =
    (tokens.idToken ? extractEmail(tokens.idToken) : undefined) ??
    extractEmail(tokens.access);
  const result: CodexUsageResult = {};
  if (email) result.email = email;

  let response: Response | undefined;
  try {
    response = await fetch(RATE_LIMITS_URL, {
      headers: { Authorization: `Bearer ${tokens.access}` },
    });
  } catch {
    return result;
  }
  if (!response.ok) {
    return result;
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.planType === "string") result.planType = body.planType;
  const primary = parseWindow(body.primary);
  if (primary) result.primary = primary;
  const secondary = parseWindow(body.secondary);
  if (secondary) result.secondary = secondary;
  if (body.credits && typeof body.credits === "object") {
    const credits = body.credits as Record<string, unknown>;
    result.credits = {
      balance:
        typeof credits.balance === "string" ? credits.balance : undefined,
      hasCredits:
        typeof credits.hasCredits === "boolean"
          ? credits.hasCredits
          : undefined,
      unlimited:
        typeof credits.unlimited === "boolean"
          ? credits.unlimited
          : undefined,
    };
  }
  return result;
}
