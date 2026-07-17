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

const SOL_TERRA_LEVELS = [
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
  if (model.id === "gpt-5.6-sol" || model.id === "gpt-5.6-terra") {
    return SOL_TERRA_LEVELS;
  }
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
