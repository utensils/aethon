/**
 * Model-picker population. Filters the global model list against the
 * user's `enabledModels` patterns from `~/.pi/agent/settings.json`,
 * always including the current model so it can never disappear from
 * the picker.
 */

import { logger } from "../logger";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "../state";
import { compilePattern, modelDescriptor, modelKey } from "./utils";
import type { TabLifecycleDeps } from "./utils";

/** Filter the picker to the user's enabledModels patterns from
 *  ~/.pi/agent/settings.json. Always include the current model. */
export function buildPickerModels(
  state: AethonAgentState,
  currentModel?: Model<Api>,
): Model<Api>[] {
  const all = state.modelRegistry.getAll();
  const enabled = state.settingsManager.getEnabledModels();
  let pickerModels: Model<Api>[];
  if (enabled && enabled.length > 0) {
    const patterns = enabled.map(compilePattern);
    pickerModels = all.filter((m) => patterns.some((p) => p.test(modelKey(m))));
  } else {
    pickerModels = state.modelRegistry.getAvailable();
  }
  const seen = new Set(pickerModels.map(modelKey));
  if (currentModel && !seen.has(modelKey(currentModel))) {
    pickerModels.unshift(currentModel);
  }
  return pickerModels;
}

export function defaultModelKey(state: AethonAgentState): string {
  const def = state.tabs.get("default");
  return def?.session.model ? modelKey(def.session.model) : "";
}

/** Ensure the picker contains `model`; if not, prepend it and push the
 *  updated list to the frontend so the picker can highlight it as
 *  active. Without this, models registered dynamically by an extension
 *  (e.g. ollama-host calling pi.registerProvider) can become a session's
 *  active model without ever appearing in the picker. */
export function ensurePickerHasModel(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  model: Model<Api> | undefined,
): void {
  if (!model) return;
  const key = modelKey(model);
  if (state.cachedModels.some((m) => m.id === key)) return;
  logger.scope("picker").debug(`prepending ${key} to picker`);
  state.cachedModels = [modelDescriptor(model), ...state.cachedModels];
  deps.send({
    type: "state_patch",
    path: "/sidebar/models",
    value: state.cachedModels.map((m) => ({ id: m.id, label: m.label })),
  });
}
