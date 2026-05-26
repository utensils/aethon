import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { maybeExitForReload } from "./dispatcherTypes";
import {
  cancelRunningToolCards,
  ensurePickerHasModel,
  ensureTab,
} from "./tab-lifecycle";

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
  const cwdOverride =
    typeof msg.cwd === "string" && msg.cwd.length > 0 ? msg.cwd : undefined;
  let initialModel: Model<Api> | undefined;
  if (typeof msg.model === "string" && msg.model.length > 0) {
    const [provider, ...rest] = msg.model.split("/");
    initialModel =
      state.modelRegistry.find(provider, rest.join("/")) ?? undefined;
  }
  const tab = await ensureTab(
    state,
    deps,
    tabId,
    cwdOverride || initialModel ? { cwdOverride, initialModel } : {},
  );
  const wantsSteer = msg.mode === "steer";
  if (wantsSteer && tab.promptInFlight) {
    state.currentAgentTabId = tabId;
    const content = msg.content;
    state.tabContext
      .run(tabId, () => tab.session.steer(content))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({ type: "error", tabId, message: `steer: ${message}` });
      });
    return;
  }
  const queued = tab.promptInFlight;
  if (queued) {
    tab.queuedCount += 1;
    const content = msg.content;
    state.tabContext
      .run(tabId, () => tab.session.followUp(content))
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
    .run(tabId, () => tab.session.prompt(content))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({ type: "error", tabId, message: `prompt: ${message}` });
    })
    .finally(() => {
      if (!tab.agentEndFired) {
        tab.promptInFlight = false;
        deps.send({ type: "response_end", tabId });
      }
      if (state.currentAgentTabId === tabId) {
        state.currentAgentTabId = undefined;
      }
      maybeExitForReload(state, deps);
    });
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
  const tab = await ensureTab(state, deps, tabId);
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
  const next = state.modelRegistry.find(provider, id);
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
