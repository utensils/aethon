import type { Api, Model } from "@mariozechner/pi-ai";

type ProviderCapabilities = {
  priorityServiceTier?: (modelId: string) => boolean;
};

const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = {
  "openai-codex": {
    // Fast mode starts at the GPT-5.4 generation. This accepts newer models
    // discovered from Pi without fabricating any model in the Codex registry.
    priorityServiceTier: (id) => /^gpt-5\.(?:[4-9]|\d{2,})(?:$|-)/.test(id),
  },
};

export function modelSupportsPriorityServiceTier(
  model: Model<Api> | undefined,
): boolean {
  return model
    ? (PROVIDER_CAPABILITIES[model.provider]?.priorityServiceTier?.(model.id) ?? false)
    : false;
}
