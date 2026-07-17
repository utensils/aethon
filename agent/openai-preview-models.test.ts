import { describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { registerOpenAIPreviewModels } from "./openai-preview-models";

describe("OpenAI preview model compatibility", () => {
  it("adds GPT-5.6 to API-key OpenAI and Codex with provider-specific windows", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const existingIds = registry.getAll().filter((m) => m.provider === "openai").map((m) => m.id);
    registerOpenAIPreviewModels(registry);

    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(registry.find("openai", id)).toMatchObject({
        id,
        provider: "openai",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    }
    expect(existingIds.every((id) => registry.find("openai", id))).toBe(true);

    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(registry.find("openai-codex", id)).toMatchObject({
        id,
        provider: "openai-codex",
        api: "openai-codex-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 272_000,
        maxTokens: 128_000,
      });
    }
  });

  it("is idempotent", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registerOpenAIPreviewModels(registry);
    const count = registry.getAll().length;
    registerOpenAIPreviewModels(registry);
    expect(registry.getAll()).toHaveLength(count);
  });
});
