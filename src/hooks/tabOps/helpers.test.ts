import { describe, expect, it } from "vitest";
import { modelForNewProjectTab } from "./helpers";

describe("modelForNewProjectTab", () => {
  const fallback = "openai-codex/gpt-5.5";

  it("uses the explicit per-launch override above everything", () => {
    const state = {
      defaultModel: "anthropic/claude-opus-4-7",
      projectModels: { p1: "qwen/qwen3" },
    };
    expect(
      modelForNewProjectTab(state, "p1", fallback, "google/gemma-4"),
    ).toBe("google/gemma-4");
  });

  it("lets /defaultModel win over per-project memory (global wins everywhere)", () => {
    const state = {
      defaultModel: "anthropic/claude-opus-4-7",
      projectModels: { p1: "qwen/qwen3" },
    };
    expect(modelForNewProjectTab(state, "p1", fallback)).toBe(
      "anthropic/claude-opus-4-7",
    );
  });

  it("falls back to per-project memory when no default is set", () => {
    const state = { projectModels: { p1: "qwen/qwen3" } };
    expect(modelForNewProjectTab(state, "p1", fallback)).toBe("qwen/qwen3");
  });

  it("falls back to the pi default when nothing else resolves", () => {
    expect(modelForNewProjectTab({}, null, fallback)).toBe(fallback);
  });

  it("ignores an empty explicit override and trims the result", () => {
    const state = { defaultModel: "  anthropic/claude-opus-4-7  " };
    expect(modelForNewProjectTab(state, null, fallback, "")).toBe(
      "anthropic/claude-opus-4-7",
    );
  });

  it("ignores per-project memory when the active project is null", () => {
    const state = { projectModels: { p1: "qwen/qwen3" } };
    expect(modelForNewProjectTab(state, null, fallback)).toBe(fallback);
  });
});
