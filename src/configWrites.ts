import { invoke } from "@tauri-apps/api/core";

import { clearConfigCache, getConfig, type AethonConfig } from "./config";

export const CONFIG_WRITE_SECTIONS = [
  "ui",
  "agent",
  "shell",
  "shortcuts",
  "voice",
  "updates",
  "devshell",
  "startup",
  "guardrails",
] as const satisfies readonly (keyof AethonConfig)[];

export type ConfigWriteSection = (typeof CONFIG_WRITE_SECTIONS)[number];

export type ConfigWritePatch = Partial<{
  [K in ConfigWriteSection]: Partial<AethonConfig[K]>;
}>;

export type ConfigWritePayload = {
  [K in ConfigWriteSection]: Record<string, unknown>;
};

export function mergeConfigPatch(
  pending: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...pending };
  for (const [key, value] of Object.entries(patch)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? { ...previous, ...value }
        : value;
  }
  return merged;
}

/** Build the full payload required by the destructive `write_config` IPC.
 *
 * `write_config` replaces the whole TOML document, so every known top-level
 * section must be included even when the caller only wants to patch one nested
 * field. Null values inside a patch are preserved intentionally: `[agent]
 * model = null` is how the UI records "(pi default)".
 */
export function buildConfigWritePayload(
  live: Partial<AethonConfig> | null | undefined,
  patch: ConfigWritePatch,
): ConfigWritePayload {
  const payload = {} as ConfigWritePayload;
  for (const section of CONFIG_WRITE_SECTIONS) {
    payload[section] = mergeConfigSection(live?.[section], patch[section]);
  }
  return payload;
}

export async function writeConfigPatch(
  patch: ConfigWritePatch,
  options?: { live?: Partial<AethonConfig> | null },
): Promise<ConfigWritePayload> {
  let live = options?.live;
  if (live === undefined) {
    try {
      // Destructive writes must merge against the current file, not the
      // read-once cache. Users can edit config.toml outside Settings, and a
      // stale cached snapshot would otherwise overwrite those changes.
      clearConfigCache();
      live = await getConfig();
    } catch {
      live = null;
    }
  }
  const config = buildConfigWritePayload(live, patch);
  await invoke("write_config", { config });
  return config;
}

function mergeConfigSection(
  liveSection: unknown,
  patchSection: unknown,
): Record<string, unknown> {
  if (isPlainObject(liveSection) && isPlainObject(patchSection)) {
    return { ...liveSection, ...patchSection };
  }
  if (isPlainObject(patchSection)) return { ...patchSection };
  if (isPlainObject(liveSection)) return { ...liveSection };
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
