import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

type RegisteredModel = NonNullable<
  Parameters<ModelRegistry["registerProvider"]>[1]["models"]
>[number];

const GPT_5_6_MODELS: RegisteredModel[] = [
  previewModel("gpt-5.6", "GPT-5.6 (Sol)", 5, 30),
  previewModel("gpt-5.6-sol", "GPT-5.6 Sol", 5, 30),
  previewModel("gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15),
  previewModel("gpt-5.6-luna", "GPT-5.6 Luna", 1, 6),
];

/** Add preview models absent from Pi to API-key OpenAI only. */
export function registerOpenAIPreviewModels(registry: ModelRegistry): void {
  const existing = registry.getAll().filter((model) => model.provider === "openai");
  const knownIds = new Set(existing.map((model) => model.id));
  const missing = GPT_5_6_MODELS.filter((model) => !knownIds.has(model.id));
  if (missing.length === 0) return;

  // Dynamic registration replaces a provider's catalog, so retain every Pi
  // built-in/custom OpenAI model. Pi's definition wins once it ships an id.
  registry.registerProvider("openai", {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "OPENAI_API_KEY",
    api: "openai-responses",
    models: [...existing.map(toRegisteredModel), ...missing],
  });
}

function previewModel(
  id: string,
  name: string,
  inputCost: number,
  outputCost: number,
): RegisteredModel {
  return {
    id,
    name,
    api: "openai-responses",
    reasoning: true,
    thinkingLevelMap: { off: null },
    input: ["text", "image"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: inputCost / 10,
      cacheWrite: inputCost * 1.25,
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  };
}

function toRegisteredModel(model: Model<Api>): RegisteredModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}
