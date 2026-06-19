/**
 * Usage-limit auto-switch: when an account hits its quota mid-session, pick
 * another stored account for the same provider that still has headroom so
 * the caller can transparently switch and continue.
 *
 * The picker is isolated here (and dependency-injected for the usage probe)
 * so it can be unit-tested without spawning sessions or hitting the network.
 */
export interface AccountCandidate {
  id: string;
  providerId: string;
}

/** Probe a single profile's live usage. Returns `true` when the account is
 *  rate-limited (or cannot be probed — treated as unusable). */
export type LimitProbe = (
  profileId: string,
  providerId: string,
) => Promise<boolean>;

/**
 * Pick the first candidate for `provider` (other than `currentId`, and not
 * already tried) whose account is NOT rate-limited. Returns `undefined` when
 * every alternative is exhausted, tried, or unprobeable.
 */
export async function pickAvailableAccount(
  candidates: readonly AccountCandidate[],
  provider: string,
  currentId: string | undefined,
  tried: ReadonlySet<string>,
  probe: LimitProbe,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.providerId !== provider) continue;
    if (candidate.id === currentId) continue;
    if (tried.has(candidate.id)) continue;
    let limited: boolean;
    try {
      limited = await probe(candidate.id, candidate.providerId);
    } catch {
      continue; // unprobeable → skip, don't risk switching to a dead account
    }
    if (!limited) return candidate.id;
  }
  return undefined;
}
