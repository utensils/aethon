import { getModels, type Api, type Model } from "@mariozechner/pi-ai";
import { openaiCodexOAuthProvider } from "@mariozechner/pi-ai/oauth";
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

const CODEX_GPT_5_6_MODELS: RegisteredModel[] = [
  codexModel("gpt-5.6-sol", "GPT-5.6 Sol", 5, 30),
  codexModel("gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15),
  codexModel("gpt-5.6-luna", "GPT-5.6 Luna", 1, 6),
];

/** Add current OpenAI models that Pi has not shipped yet. Pi's native model
 * definitions take precedence as soon as they become available. */
export function registerOpenAIPreviewModels(registry: ModelRegistry): void {
  // Some tests and extension shims intentionally expose only the read side of
  // ModelRegistry. Compatibility registration is a no-op on those facades.
  if (
    typeof (registry as { registerProvider?: unknown }).registerProvider !==
    "function"
  ) {
    return;
  }
  const existing = registry.getAll().filter((model) => model.provider === "openai");
  const knownIds = new Set(existing.map((model) => model.id));
  const missing = GPT_5_6_MODELS.filter((model) => !knownIds.has(model.id));
  if (missing.length > 0) {
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

  registerCodexModels(registry);
}

function registerCodexModels(registry: ModelRegistry): void {
  const existing = registry
    .getAll()
    .filter((model) => model.provider === "openai-codex");
  const upstreamIds = new Set(
    getModels("openai-codex").map((model) => model.id),
  );
  const compatibilityIds = new Set(
    CODEX_GPT_5_6_MODELS.filter((model) => !upstreamIds.has(model.id)).map(
      (model) => model.id,
    ),
  );
  if (compatibilityIds.size === 0) return;

  // Replace stale user-authored 5.6 entries while Pi lacks native support.
  // This is what prevents a local models.json typo from changing compaction.
  const retained = existing.filter((model) => !compatibilityIds.has(model.id));
  const { id: _providerId, ...oauth } = openaiCodexOAuthProvider;
  registry.registerProvider("openai-codex", {
    name: "OpenAI Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    api: "openai-codex-responses",
    oauth,
    models: [
      ...retained.map(toRegisteredModel),
      ...CODEX_GPT_5_6_MODELS.filter((model) => compatibilityIds.has(model.id)),
    ],
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

function codexModel(
  id: string,
  name: string,
  inputCost: number,
  outputCost: number,
): RegisteredModel {
  return {
    id,
    name,
    api: "openai-codex-responses",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" },
    input: ["text", "image"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: inputCost / 10,
      cacheWrite: 0,
    },
    contextWindow: 272_000,
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
