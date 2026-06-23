import { readFileSync } from "node:fs";
import { logger } from "../logger";
import type { AethonAgentState } from "../state";
import type { DispatcherDeps, InboundMessage } from "../dispatcherTypes";
import { clearPendingContextUsageEmit } from "../context-usage";
import { ensureTab } from "../tab-lifecycle";
import { removeTrailingFailureMessage } from "../tab-lifecycle/retry";
import { authProfileAuthPath, loadAuthProfilesState } from "./store";
import { pickAvailableAccount, type LimitProbe } from "./auto-switch";
import { fetchCodexUsage, type TokenProvider } from "./codex-usage";
import { servicesForProfile } from "./services-cache";
import { findProfile, markProfileUsed, stringField } from "./profile-state";

const CODEX_PROVIDER_ID = "openai-codex";

interface ContinuableSession {
  agent?: { continue?: () => Promise<void> };
}

/**
 * Recover from a usage-limit hit by transparently switching the tab to
 * another account that still has headroom, then re-running the failed turn.
 * Runs inside the bridge that owns the tab's session (so the re-run uses the
 * new credentials). Returns `true` when it switched + resumed — the caller
 * then suppresses the error so the turn "continues on its own". Returns
 * `false` when no alternative account is available (caller surfaces the
 * clean error).
 *
 * Loop-safe: each bounced account is recorded on the tab record and skipped
 * on subsequent hits within the same prompt; a clean turn clears the set.
 */
export async function tryAutoSwitchOnUsageLimit(
  state: AethonAgentState,
  deps: DispatcherDeps,
  tabId: string,
): Promise<boolean> {
  const existing = state.tabs.get(tabId);
  if (!existing) return false;
  // A worker bridge's in-memory profile list can be stale (accounts added
  // after it spawned live only in the global bridge until persisted); reload
  // from disk so a freshly-added spare account is considered.
  state.authProfiles = loadAuthProfilesState(state.userDir);
  const currentId = state.tabAuthProfileIds.get(tabId);
  const current = currentId
    ? state.authProfiles.profiles.find((p) => p.id === currentId)
    : undefined;
  const provider =
    current?.providerId ?? existing.session.model?.provider ?? undefined;
  if (provider !== CODEX_PROVIDER_ID) return false;

  const tried = existing.autoSwitchTried ?? new Set<string>();
  if (currentId) tried.add(currentId);

  // Only choose an account whose usage is *definitively* not limited. A
  // network/HTTP failure leaves `limitReached` undefined — treat that as
  // unavailable rather than risk switching onto an unprobeable (possibly
  // exhausted) account.
  const probe: LimitProbe = async (profileId, providerId) => {
    const usage = await fetchCodexUsage(
      profileTokenProvider(state, profileId, providerId),
    );
    return usage.limitReached !== false;
  };
  const chosen = await pickAvailableAccount(
    state.authProfiles.profiles,
    provider,
    currentId,
    tried,
    probe,
  );
  if (!chosen) return false;
  tried.add(chosen);

  const chosenProfile = state.authProfiles.profiles.find(
    (p) => p.id === chosen,
  );
  const previousModel = existing.session.model;
  const cwd = state.tabProjectCwds.get(tabId);
  clearPendingContextUsageEmit(existing);
  state.tabs.delete(tabId);
  state.tabAuthProfileIds.set(tabId, chosen);
  const services = servicesForProfile(state, chosen, { forceRefresh: true });
  const nextModel =
    previousModel &&
    services.modelRegistry.find(previousModel.provider, previousModel.id);
  const rec = await ensureTab(state, deps, tabId, {
    cwdOverride: cwd,
    initialModel: nextModel || previousModel,
  });
  rec.autoSwitchTried = tried;
  markProfileUsed(state, chosen);

  deps.send({
    type: "auth_profile_changed",
    tabId,
    profileId: chosen,
    model: rec.session.model
      ? `${rec.session.model.provider}/${rec.session.model.id}`
      : "",
  });
  deps.send({
    type: "notice",
    tabId,
    message: `Switched to ${chosenProfile?.label ?? "another account"} — previous account hit its usage limit. Continuing…`,
  });
  // NB: no full `auth_profiles` snapshot here. This may run in a tab worker
  // whose `tabAuthProfileIds` is worker-local; emitting the snapshot would
  // clobber the frontend's `activeByTab` for other tabs. The
  // `auth_profile_changed` delta above updates just this tab's selection.

  // Drop the trailing error and re-run the last user turn on the new
  // account (same mechanism the retry path uses, but on fresh credentials).
  removeTrailingFailureMessage(rec.session);
  const agent = (rec.session as ContinuableSession).agent;
  const continueTurn = agent?.continue;
  if (typeof continueTurn !== "function") return false;
  rec.promptInFlight = true;
  rec.agentEndFired = false;
  state.currentAgentTabId = tabId;
  void state.tabContext
    .run(tabId, () => continueTurn.call(agent))
    .catch((err: unknown) => {
      // Mirror the retry path's full cleanup so the tab doesn't stay "busy"
      // and later mutations aren't misattributed to it.
      rec.promptInFlight = false;
      rec.agentEndFired = true;
      if (state.currentAgentTabId === tabId) {
        state.currentAgentTabId = undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", tabId, message: `auto-switch: ${message}` });
      deps.send({ type: "response_end", tabId });
    });
  return true;
}

/** A {@link TokenProvider} backed by a profile's pi AuthStorage, so OAuth
 *  refresh + single-use refresh-token rotation go through pi's cross-process
 *  lock instead of an unsynchronised file read/write. */
function profileTokenProvider(
  state: AethonAgentState,
  profileId: string,
  providerId: string,
): TokenProvider {
  return () =>
    servicesForProfile(state, profileId).authStorage.getApiKey(providerId);
}

export function parseIdTokenEmail(idToken: string): string | undefined {
  const segments = idToken.split(".");
  if (segments.length < 2) return undefined;
  const payload = segments[1];
  if (!payload) return undefined;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const claims = JSON.parse(json) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export async function handleFetchUsage(
  state: AethonAgentState,
  deps: Pick<DispatcherDeps, "send">,
  msg: InboundMessage,
): Promise<void> {
  const profileId = stringField(msg.profileId);
  logger.scope("auth-usage").debug(`fetch usage for ${profileId}`);
  try {
    const profile = findProfile(state, profileId);
    if (!profile) throw new Error("unknown profileId");

    if (profile.providerId === CODEX_PROVIDER_ID) {
      const usage = await fetchCodexUsage(
        profileTokenProvider(state, profile.id, profile.providerId),
      );
      // debug-level + no email — the account address is PII and the bridge
      // logger defaults to info.
      logger
        .scope("auth-usage")
        .debug(
          `${profileId} → hasEmail=${usage.email ? "y" : "n"} plan=${usage.planType ?? "none"} primary=${usage.primary?.usedPercent ?? "none"}`,
        );
      deps.send({
        type: "auth_profile_usage",
        profileId: profile.id,
        ...usage,
      });
    } else {
      const authPath = authProfileAuthPath(state.userDir, profile.id);
      let email: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<
          string,
          unknown
        >;
        const entry = parsed[profile.providerId];
        if (entry && typeof entry === "object") {
          const creds = entry as Record<string, unknown>;
          const idToken =
            typeof creds.id_token === "string"
              ? creds.id_token
              : typeof creds.idToken === "string"
                ? creds.idToken
                : undefined;
          if (idToken) email = parseIdTokenEmail(idToken);
        }
      } catch {
        /* no credentials to read email from */
      }
      deps.send({
        type: "auth_profile_usage",
        profileId: profile.id,
        ...(email ? { email } : {}),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "auth_profile_usage",
      profileId,
      error: message,
    });
  }
}
