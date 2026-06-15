import { recomputeModelPicker } from "../../utils/modelPicker";
import type { BridgeMessageHandler } from "./types";

/** Per-tab model change. Bridge tags with tabId; default for legacy.
 *  Sidebar model picker is global — reflects the active tab's model.
 *  When a non-active tab changes model we leave the picker alone so the
 *  user's currently visible context isn't surprised by it. */
export const handleModelChanged: BridgeMessageHandler = (data, ctx) => {
  const model = (data.model as string) || "";
  const tabId = (data.tabId as string | undefined) ?? "default";
  const thinkingLevel =
    typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined;
  ctx.updateTab(tabId, (tab) => ({
    ...tab,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }));
  if (data.type === "model_changed") {
    ctx.recordProjectModel(model, tabId);
  }
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => {
      const codexFastMode =
        typeof data.codexFastMode === "boolean"
          ? data.codexFastMode
          : prev.codexFastMode;
      return {
        ...prev,
        status:
          data.type === "codex_fast_mode_changed"
            ? `Codex Fast mode ${codexFastMode ? "enabled" : "disabled"}`
            : thinkingLevel
              ? `switched to ${model} · reasoning ${thinkingLevel}`
              : `switched to ${model}`,
        ...(thinkingLevel
          ? { thinkingLevel, defaultThinkingLevel: thinkingLevel }
          : {}),
        codexFastMode,
        sidebar: recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          model,
        ),
      };
    });
  }
};
