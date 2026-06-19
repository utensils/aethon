/**
 * Codex account usage + identity, fetched directly from OpenAI's HTTP API
 * using a profile's own stored OAuth credentials. No dependency on the
 * `codex` binary — this keeps each account fully isolated (the bearer
 * token scopes the request to exactly one account) and avoids PATH /
 * temp-dir fragility.
 *
 * Self-contained and side-effect-light: the only write is rotating the
 * refreshed token back into the profile's auth.json. Designed to be
 * reusable anywhere in the UI that needs Codex usage/identity, not just
 * the Accounts panel.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const USER_AGENT = "codex_cli_rs/0.136.0 (Aethon)";
const ORIGINATOR = "codex_cli_rs";

export interface CodexUsageWindow {
  /** 0-100 percent of the window consumed. */
  usedPercent: number;
  /** Unix epoch (seconds) when the window resets. */
  resetsAt?: number;
  /** Window length in minutes (300 = 5-hour, 10080 = weekly). */
  windowDurationMins?: number;
}

export interface CodexUsageResult {
  email?: string;
  accountId?: string;
  planType?: string;
  /** True when the account has hit its limit and prompts will be rejected. */
  limitReached?: boolean;
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
  credits?: { balance?: string; hasCredits?: boolean; unlimited?: boolean };
}

interface RefreshedTokens {
  access: string;
  refresh: string;
  idToken?: string;
  expires: number;
  accountId?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const segment = parts[1];
  if (!segment) return undefined;
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

function jwtEmail(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  if (typeof payload.email === "string") return payload.email;
  const auth = payload["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  return typeof auth?.email === "string" ? auth.email : undefined;
}

function jwtAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Exchange a stored refresh token for a fresh access/id token set.
 *  OpenAI rotates refresh tokens (single-use), so the caller must persist
 *  the returned `refresh` value. */
async function refreshTokens(refreshToken: string): Promise<RefreshedTokens> {
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
    throw new Error(
      `token refresh failed: ${response.status} ${text.slice(0, 200)}`,
    );
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
    idToken: typeof json.id_token === "string" ? json.id_token : undefined,
    expires: Date.now() + json.expires_in * 1000,
    accountId: jwtAccountId(json.access_token),
  };
}

function windowFrom(value: unknown): CodexUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.used_percent !== "number") return undefined;
  const w: CodexUsageWindow = { usedPercent: rec.used_percent };
  if (typeof rec.reset_at === "number") w.resetsAt = rec.reset_at;
  if (typeof rec.limit_window_seconds === "number") {
    w.windowDurationMins = Math.round(rec.limit_window_seconds / 60);
  }
  return w;
}

/** Parse the `/backend-api/codex/usage` response body into our shape. */
export function parseCodexUsageBody(
  body: Record<string, unknown>,
): Omit<CodexUsageResult, "accountId"> {
  const result: Omit<CodexUsageResult, "accountId"> = {};
  if (typeof body.email === "string") result.email = body.email;
  if (typeof body.plan_type === "string") result.planType = body.plan_type;

  const rateLimit = body.rate_limit as Record<string, unknown> | undefined;
  if (rateLimit && typeof rateLimit === "object") {
    if (typeof rateLimit.limit_reached === "boolean") {
      result.limitReached = rateLimit.limit_reached;
    }
    const primary = windowFrom(rateLimit.primary_window);
    if (primary) result.primary = primary;
    const secondary = windowFrom(rateLimit.secondary_window);
    if (secondary) result.secondary = secondary;
  }

  const credits = body.credits as Record<string, unknown> | undefined;
  if (credits && typeof credits === "object") {
    result.credits = {
      balance:
        typeof credits.balance === "number"
          ? String(credits.balance)
          : typeof credits.balance === "string"
            ? credits.balance
            : undefined,
      hasCredits:
        typeof credits.has_credits === "boolean"
          ? credits.has_credits
          : undefined,
      unlimited:
        typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
    };
  }
  return result;
}

/**
 * Fetch usage + identity for a single Codex profile. Refreshes the token,
 * persists the rotated refresh token back to the profile, then calls the
 * usage API scoped to that account.
 */
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
  if (!storedRefresh) throw new Error("no refresh token stored");

  const tokens = await refreshTokens(storedRefresh);

  // Persist rotated tokens — refresh tokens are single-use.
  writeFileSync(
    profileAuthPath,
    JSON.stringify(
      {
        ...stored,
        [providerId]: {
          ...creds,
          access: tokens.access,
          refresh: tokens.refresh,
          expires: tokens.expires,
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
        },
      },
      null,
      2,
    ),
  );

  const accountId =
    tokens.accountId ??
    (typeof creds.accountId === "string" ? creds.accountId : undefined);

  const result: CodexUsageResult = {};
  const email = jwtEmail(tokens.idToken) ?? jwtEmail(tokens.access);
  if (email) result.email = email;
  if (accountId) result.accountId = accountId;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access}`,
    "User-Agent": USER_AGENT,
    originator: ORIGINATOR,
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  let response: Response;
  try {
    response = await fetch(USAGE_URL, { headers });
  } catch {
    return result; // network error — identity is still useful
  }
  if (!response.ok) return result;

  const body = (await response.json()) as Record<string, unknown>;
  Object.assign(result, parseCodexUsageBody(body));
  // Prefer JWT email if the API omitted it.
  if (!result.email && email) result.email = email;
  if (accountId) result.accountId = accountId;
  return result;
}
