/**
 * Account-selection helpers shared by the header `AccountSelector` and the
 * task-launcher account chip. Both surfaces answer the same two questions:
 *
 *   1. which stored accounts can back a given model provider, and
 *   2. which one would a prompt actually use by default
 *
 * Keeping the resolution in one place means the header and the launcher can
 * never disagree about which account is "active" for a provider.
 */

/** Minimal account shape these helpers need — a subset of `AuthProfileMeta`. */
export interface ProviderScopedProfile {
  id: string;
  providerId: string;
}

/** Provider id ("openai-codex") embedded in a model id
 *  ("openai-codex/gpt-5.5"). Undefined when the model has no provider
 *  prefix (or no model is selected yet). */
export function providerOfModelId(
  modelId: string | undefined,
): string | undefined {
  return typeof modelId === "string" && modelId.includes("/")
    ? modelId.split("/")[0]
    : undefined;
}

/** Accounts that can back `provider`. Switching to a profile from another
 *  provider would point the session's auth at a provider that can't back the
 *  current model, so we filter to the model's provider. When the provider is
 *  unknown (no model yet), every profile is selectable. */
export function accountsForProvider<T extends ProviderScopedProfile>(
  profiles: readonly T[],
  provider: string | undefined,
): T[] {
  return provider
    ? profiles.filter((p) => p.providerId === provider)
    : [...profiles];
}

/** When exactly one provider default is configured, use it as the global
 *  fallback selection (covers the common single-provider setup where the
 *  provider can't be inferred from the model id yet). */
export function soleDefaultProfileId(
  defaultByProvider: Record<string, string> | undefined,
): string | undefined {
  const values = Object.values(defaultByProvider ?? {});
  return values.length === 1 ? values[0] : undefined;
}

/** Resolve the effective profile id from an ordered list of candidates,
 *  keeping only ids that are actually selectable. Falls back to the first
 *  selectable account so the chip always reflects a concrete choice. */
export function resolveSelectableProfileId(
  selectable: readonly ProviderScopedProfile[],
  ...candidates: Array<string | undefined>
): string | undefined {
  const ids = new Set(selectable.map((p) => p.id));
  return candidates.find((id) => id && ids.has(id)) ?? selectable[0]?.id;
}
