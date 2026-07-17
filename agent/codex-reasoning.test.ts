import { describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import type { TabRecord } from "./state";
import {
  codexReasoningLevels,
  selectedThinkingLevel,
  setTabThinkingLevel,
} from "./codex-reasoning";

function model(id: string): Model<never> {
  return {
    provider: "openai-codex",
    id,
    name: id,
  } as unknown as Model<never>;
}

function tab(
  id: string,
): TabRecord & { thinkingLevelSpy: ReturnType<typeof vi.fn> } {
  const setThinkingLevel = vi.fn();
  return {
    thinkingLevelSpy: setThinkingLevel,
    session: {
      model: model(id),
      thinkingLevel: "medium",
      setThinkingLevel,
    },
  } as unknown as TabRecord & {
    thinkingLevelSpy: ReturnType<typeof vi.fn>;
  };
}

describe("Codex 5.6 reasoning efforts", () => {
  it("keeps Sol and Terra Ultra-capable while Luna stops at Max", () => {
    expect(codexReasoningLevels(model("gpt-5.6-sol"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(codexReasoningLevels(model("gpt-5.6-terra"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(codexReasoningLevels(model("gpt-5.6-luna"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(codexReasoningLevels(model("gpt-5.5"))).toBeUndefined();
  });

  it("uses Pi xhigh underneath while preserving the selected Max effort", () => {
    const record = tab("gpt-5.6-sol");
    setTabThinkingLevel(record, "max");
    expect(record.thinkingLevelSpy).toHaveBeenCalledWith("xhigh");
    expect(selectedThinkingLevel(record)).toBe("max");

    setTabThinkingLevel(record, "high");
    expect(record.thinkingLevelSpy).toHaveBeenLastCalledWith("high");
    expect(record.codexExtendedReasoningEffort).toBeUndefined();
  });

  it("rejects Ultra for Luna and older Codex models", () => {
    expect(() => setTabThinkingLevel(tab("gpt-5.6-luna"), "ultra")).toThrow(
      "ultra is not supported",
    );
    expect(() => setTabThinkingLevel(tab("gpt-5.5"), "max")).toThrow(
      "max is not supported",
    );
  });

  it("clamps a persisted Ultra default when the selected model lacks it", () => {
    const luna = tab("gpt-5.6-luna");
    setTabThinkingLevel(luna, "ultra", { clampUnsupportedExtended: true });
    expect(selectedThinkingLevel(luna)).toBe("max");

    const legacy = tab("gpt-5.5");
    setTabThinkingLevel(legacy, "ultra", { clampUnsupportedExtended: true });
    expect(legacy.thinkingLevelSpy).toHaveBeenCalledWith("xhigh");
    expect(legacy.codexExtendedReasoningEffort).toBeUndefined();
  });
});
