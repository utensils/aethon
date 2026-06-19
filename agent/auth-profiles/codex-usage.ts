/**
 * Codex account usage + identity, fetched directly from OpenAI's HTTP API
 * using a profile's own access token. No dependency on the `codex` binary —
 * the bearer token scopes the request to exactly one account, so each
 * account stays fully isolated, and there is no PATH / temp-dir fragility.
 *
 * Token handling is delegated to a caller-supplied `getAccessToken` (backed
 * by pi's `AuthStorage`), so OAuth refresh + single-use refresh-token
 * rotation happen through the same cross-process lock pi uses — this module
 * never reads or writes auth.json itself. Designed to be reusable anywhere
 * in the UI that needs Codex usage/identity, not just the Accounts panel.
 */
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const USER_AGENT = "codex_cli_rs/0.136.0 (Aethon)";
const ORIGINATOR = "codex_cli_rs";

/** Returns a valid access token for the account, refreshing through the
 *  locked auth store if needed. `undefined` means the account can't
 *  currently authenticate. */
export type TokenProvider = () => Promise<string | undefined>;

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

function jwtEmail(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  if (typeof payload.email === "string") return payload.email;
  const auth = payload["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  return typeof auth?.email === "string" ? auth.email : undefined;
}

function jwtAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Normalise one rate-limit window. Accepts both the `/codex/usage` shape
 *  (`used_percent` + `limit_window_seconds` + `reset_at`) and the
 *  app-server `rate_limits` shape (`used_percent` + `window_minutes` +
 *  `resets_at`). */
function windowFrom(value: unknown): CodexUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const usedPercent = num(rec.used_percent);
  if (usedPercent === undefined) return undefined;
  const w: CodexUsageWindow = { usedPercent };
  const resetsAt = num(rec.reset_at) ?? num(rec.resets_at);
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  const windowSeconds = num(rec.limit_window_seconds);
  const windowMinutes = num(rec.window_minutes);
  if (windowSeconds !== undefined) {
    w.windowDurationMins = Math.round(windowSeconds / 60);
  } else if (windowMinutes !== undefined) {
    w.windowDurationMins = windowMinutes;
  }
  return w;
}

/**
 * Parse the Codex usage response into our shape. Tolerant of both payload
 * variants seen in the wild:
 *   - `/backend-api/codex/usage`: `rate_limit.{primary,secondary}_window`,
 *     `rate_limit.limit_reached`.
 *   - app-server `rate_limits`: `rate_limits.{primary,secondary}`,
 *     `rate_limit_reached_type` (non-null ⇒ limit reached).
 */
export function parseCodexUsageBody(
  body: Record<string, unknown>,
): Omit<CodexUsageResult, "accountId"> {
  const result: Omit<CodexUsageResult, "accountId"> = {};
  if (typeof body.email === "string") result.email = body.email;
  if (typeof body.plan_type === "string") result.planType = body.plan_type;

  const rateLimit = (body.rate_limit ?? body.rate_limits) as
    | Record<string, unknown>
    | undefined;
  if (rateLimit && typeof rateLimit === "object") {
    if (typeof rateLimit.limit_reached === "boolean") {
      result.limitReached = rateLimit.limit_reached;
    } else if ("rate_limit_reached_type" in rateLimit) {
      result.limitReached =
        rateLimit.rate_limit_reached_type != null &&
        rateLimit.rate_limit_reached_type !== "";
    }
    if (typeof rateLimit.plan_type === "string" && !result.planType) {
      result.planType = rateLimit.plan_type;
    }
    const primary = windowFrom(
      rateLimit.primary_window ?? rateLimit.primary,
    );
    if (primary) result.primary = primary;
    const secondary = windowFrom(
      rateLimit.secondary_window ?? rateLimit.secondary,
    );
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
 * Fetch usage + identity for a single Codex account, scoped to the token
 * `getAccessToken` returns. Identity (email/accountId) is read from the
 * access-token JWT and the response body; usage from the response body.
 * Returns identity-only on any network/HTTP failure so the caller can still
 * show who the account is.
 */
export async function fetchCodexUsage(
  getAccessToken: TokenProvider,
): Promise<CodexUsageResult> {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("no access token for account");

  const accountId = jwtAccountId(accessToken);
  const result: CodexUsageResult = {};
  const jwtMail = jwtEmail(accessToken);
  if (jwtMail) result.email = jwtMail;
  if (accountId) result.accountId = accountId;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
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
  const parsed = parseCodexUsageBody(body);
  // Body email is authoritative (the Codex access JWT often omits it).
  Object.assign(result, parsed);
  if (!result.email && jwtMail) result.email = jwtMail;
  if (accountId) result.accountId = accountId;
  return result;
}
