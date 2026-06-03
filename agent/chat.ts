import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState, TabRecord } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { maybeExitForReload } from "./dispatcherTypes";
import {
  cancelAethonRetry,
  cancelRunningToolCards,
  ensurePickerHasModel,
  ensureTab,
} from "./tab-lifecycle";
import {
  modelRegistryForModelId,
  refreshAuthServicesForTab,
  refreshTabSessionModelFromAuthServices,
} from "./auth-profiles";
import { detectSubagentMention } from "./subagents/steer";
import { getSubagentsForCwd } from "./subagents";
import { emitContextUsage } from "./context-usage";

export async function handleChat(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  if (!msg.content) {
    deps.send({ type: "error", message: "chat: missing content" });
    return;
  }
  const tabId = msg.tabId ?? "default";
  // Per-tab hard-guardrail override rides each chat so the source guard sees
  // the current value before this turn's tool calls (and survives a respawn).
  if (typeof msg.hardEnforce === "boolean") {
    state.tabHardEnforce.set(tabId, msg.hardEnforce);
  }
  // Explicit `@name` subagent invocation: record a one-shot steer consumed by
  // the before_agent_start hook so this turn delegates to that subagent.
  // Resolve against this tab's cwd so the mention matches the tab's project.
  const mention = detectSubagentMention(msg.content);
  if (mention) {
    const tabCwd = state.tabProjectCwds.get(tabId) ?? state.currentProjectCwd;
    if (getSubagentsForCwd(state, tabCwd).byName.has(mention)) {
      state.pendingExplicitSubagent.set(tabId, mention);
    }
  }
  const modelId =
    typeof msg.model === "string" && msg.model.length > 0
      ? msg.model
      : undefined;
  const authServicesRefreshed = refreshAuthServicesForTab(state, tabId, {
    modelId,
  });
  const cwdOverride =
    typeof msg.cwd === "string" && msg.cwd.length > 0 ? msg.cwd : undefined;
  let initialModel: Model<Api> | undefined;
  if (modelId) {
    const [provider, ...rest] = modelId.split("/");
    initialModel =
      modelRegistryForModelId(state, tabId, modelId).find(
        provider,
        rest.join("/"),
      ) ?? undefined;
  }
  const tab = await ensureTab(
    state,
    deps,
    tabId,
    cwdOverride || initialModel ? { cwdOverride, initialModel } : {},
  );
  if (authServicesRefreshed) {
    refreshTabSessionModelFromAuthServices(state, tabId);
  }
  const wantsSteer = msg.mode === "steer";
  const images = normalizeImages(msg.images);
  const busyForTurn = tab.promptInFlight || isUnderlyingSessionBusy(tab);
  if (busyForTurn && !tab.promptInFlight) {
    tab.promptInFlight = true;
    tab.agentEndFired = false;
    state.currentAgentTabId = tabId;
  }
  if (wantsSteer && busyForTurn) {
    state.currentAgentTabId = tabId;
    const content = msg.content;
    state.tabContext
      .run(tabId, () =>
        images.length > 0
          ? tab.session.steer(content, images)
          : tab.session.steer(content),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({ type: "error", tabId, message: `steer: ${message}` });
      });
    return;
  }
  const queued = busyForTurn;
  if (queued) {
    tab.queuedCount += 1;
    const content = msg.content;
    state.tabContext
      .run(tabId, () =>
        images.length > 0
          ? tab.session.followUp(content, images)
          : tab.session.followUp(content),
      )
      .catch((err: unknown) => {
        tab.queuedCount = Math.max(0, tab.queuedCount - 1);
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "queue_reset",
          tabId,
          queued: tab.queuedCount,
        });
        deps.send({ type: "error", tabId, message: `followUp: ${message}` });
      });
    deps.send({ type: "queued", tabId });
    return;
  }

  tab.promptInFlight = true;
  tab.agentEndFired = false;
  state.currentAgentTabId = tabId;
  const content = msg.content;
  state.tabContext
    .run(tabId, () =>
      images.length > 0
        ? tab.session.prompt(content, { images })
        : tab.session.prompt(content),
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", tabId, message: `prompt: ${message}` });
    })
    .finally(() => {
      const stillStreamingOrRetrying = isUnderlyingSessionBusy(tab);
      if (!tab.agentEndFired && !stillStreamingOrRetrying) {
        tab.promptInFlight = false;
        deps.send({ type: "response_end", tabId });
      }
      if (state.currentAgentTabId === tabId && !stillStreamingOrRetrying) {
        state.currentAgentTabId = undefined;
      }
      maybeExitForReload(state, deps);
    });
}

function isUnderlyingSessionBusy(tab: TabRecord): boolean {
  const sessionFlags = tab.session as {
    isStreaming?: unknown;
    isRetrying?: unknown;
  };
  return (
    tab.aethonRetryInFlight === true ||
    sessionFlags.isStreaming === true ||
    sessionFlags.isRetrying === true
  );
}

function normalizeImages(images: InboundMessage["images"]): ImageContent[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter(
      (image): image is { mimeType: string; data: string } =>
        typeof image?.mimeType === "string" &&
        image.mimeType.startsWith("image/") &&
        typeof image.data === "string" &&
        image.data.length > 0,
    )
    .map((image) => ({
      type: "image" as const,
      mimeType: image.mimeType,
      data: image.data,
    }));
}

export async function handleSetModel(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = msg.tabId ?? "default";
  if (!msg.id) {
    deps.send({ type: "error", tabId, message: "set_model: missing id" });
    return;
  }
  const authServicesRefreshed = refreshAuthServicesForTab(state, tabId, {
    modelId: msg.id,
  });
  const tab = await ensureTab(state, deps, tabId);
  if (authServicesRefreshed) {
    refreshTabSessionModelFromAuthServices(state, tabId);
  }
  if (tab.promptInFlight) {
    deps.send({
      type: "notice",
      tabId,
      message: "agent busy — stop the current prompt before switching models",
    });
    return;
  }
  const [provider, ...rest] = msg.id.split("/");
  const id = rest.join("/");
  const next = modelRegistryForModelId(state, tabId, msg.id).find(provider, id);
  if (!next) {
    deps.send({
      type: "error",
      tabId,
      message: `set_model: unknown model ${msg.id}`,
    });
    return;
  }
  try {
    await tab.session.setModel(next);
    await state.resourceLoader.reload();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      tabId,
      message: `set_model: ${message}`,
    });
    return;
  }
  deps.scheduleStateFileWrite();
  ensurePickerHasModel(state, deps, next);
  deps.send({ type: "model_changed", tabId, model: msg.id });
  emitContextUsage(state, deps, tabId, tab);
}

export function handleStop(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const tabId = msg.tabId ?? "default";
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (
    typeof (tab.session as { clearQueue?: () => unknown }).clearQueue ===
    "function"
  ) {
    try {
      (tab.session as { clearQueue: () => unknown }).clearQueue();
    } catch {
      /* best effort */
    }
  }
  tab.queuedCount = 0;
  cancelAethonRetry(tab);
  deps.send({ type: "queue_reset", tabId });
  cancelRunningToolCards(deps, tab, tabId);
  if (
    typeof (tab.session as { abortBash?: () => unknown }).abortBash ===
    "function"
  ) {
    try {
      (tab.session as { abortBash: () => unknown }).abortBash();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", tabId, message: `abort bash: ${message}` });
    }
  }
  tab.session.abort().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({ type: "error", tabId, message: `abort: ${message}` });
  });
}
