import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { TabRecord } from "./state";

export type CodexExtendedReasoningEffort = "max" | "ultra";
export type AethonThinkingLevel = ThinkingLevel | CodexExtendedReasoningEffort;

const BASE_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Codex models exposing the full low → ultra effort ladder (Ultra is the
 *  auto-delegating orchestration mode). Mirrors the upstream Codex model
 *  catalog's `supported_reasoning_levels`. */
const FULL_EFFORT_MODELS = new Set([
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
const FULL_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const LUNA_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function normalizeAethonThinkingLevel(
  value: unknown,
): AethonThinkingLevel | undefined {
  if (value === "max" || value === "ultra") return value;
  return typeof value === "string" && BASE_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}

export function codexReasoningLevels(
  model: Model<Api> | undefined,
): readonly string[] | undefined {
  if (model?.provider !== "openai-codex") return undefined;
  if (model.id === "gpt-5.6-luna") return LUNA_LEVELS;
  if (FULL_EFFORT_MODELS.has(model.id)) return FULL_EFFORT_LEVELS;
  return undefined;
}

export function isCodexExtendedReasoningEffort(
  level: AethonThinkingLevel,
): level is CodexExtendedReasoningEffort {
  return level === "max" || level === "ultra";
}

export function piThinkingLevel(level: AethonThinkingLevel): ThinkingLevel {
  return isCodexExtendedReasoningEffort(level) ? "xhigh" : level;
}

export function setTabThinkingLevel(
  tab: TabRecord,
  level: AethonThinkingLevel,
  options: { clampUnsupportedExtended?: boolean } = {},
): void {
  if (isCodexExtendedReasoningEffort(level)) {
    const supported = codexReasoningLevels(tab.session.model ?? undefined);
    if (!supported?.includes(level)) {
      if (options.clampUnsupportedExtended) {
        if (level === "ultra" && supported?.includes("max")) {
          tab.codexExtendedReasoningEffort = "max";
          tab.session.setThinkingLevel("xhigh");
          return;
        }
        tab.codexExtendedReasoningEffort = undefined;
        tab.session.setThinkingLevel("xhigh");
        return;
      }
      throw new Error(`${level} is not supported by the selected model`);
    }
    tab.codexExtendedReasoningEffort = level;
    tab.session.setThinkingLevel("xhigh");
    return;
  }
  tab.codexExtendedReasoningEffort = undefined;
  tab.session.setThinkingLevel(level);
}

export function selectedThinkingLevel(tab: TabRecord): string | undefined {
  return tab.codexExtendedReasoningEffort ?? tab.session.thinkingLevel;
}
