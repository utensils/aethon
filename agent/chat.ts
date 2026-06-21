import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
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
import {
  detectBackgroundSubagentIntent,
  detectLeadingSubagentMentions,
} from "./subagents/steer";
import { getSubagentsForCwd } from "./subagents";
import { emitContextUsage } from "./context-usage";
import { supportsCodexFastMode } from "./codex-fast-mode";
import {
  FileReferenceError,
  expandFileReferencesInPrompt,
} from "./file-references";
import { logger } from "./logger";

const chatLog = logger.scope("chat");

export async function handleChat(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = msg.tabId ?? "default";
  const controlRequestId =
    typeof msg.controlRequestId === "string" && msg.controlRequestId.length > 0
      ? msg.controlRequestId
      : undefined;
  const scheduledRun = scheduledRunFromMessage(msg);
  if (!msg.content) {
    completeScheduledRun(deps, tabId, scheduledRun, false, "chat: missing content");
    deps.send({ type: "error", message: "chat: missing content", controlRequestId });
    return;
  }
  chatLog.info(`received tabId=${tabId} chars=${msg.content.length}`);
  // Per-tab hard-guardrail override rides each chat so the source guard sees
  // the current value before this turn's tool calls (and survives a respawn).
  if (typeof msg.hardEnforce === "boolean") {
    state.tabHardEnforce.set(tabId, msg.hardEnforce);
  }
  if (typeof msg.planMode === "boolean") {
    state.tabPlanMode.set(tabId, msg.planMode);
  }
  const cwdOverride =
    typeof msg.cwd === "string" && msg.cwd.length > 0 ? msg.cwd : undefined;
  // Explicit `@name` subagent invocation: record a one-shot steer consumed by
  // the before_agent_start hook so this turn delegates to that subagent.
  // Resolve against this tab's cwd so the mention matches the tab's project.
  const tabCwdForMention =
    cwdOverride ?? state.tabProjectCwds.get(tabId) ?? state.currentProjectCwd;
  const tabSubagents = getSubagentsForCwd(state, tabCwdForMention).byName;
  const mentions = detectLeadingSubagentMentions(msg.content).filter((name) =>
    tabSubagents.has(name),
  );
  if (mentions.length > 0) {
    state.pendingExplicitSubagent.set(tabId, {
      names: [...new Set(mentions)],
      surface: detectBackgroundSubagentIntent(msg.content)
        ? "background"
        : "inline",
    });
  }
  // Adopt the tab's account when this is a fresh (respawned) worker that
  // doesn't yet know it. Only fill the gap — never override a live
  // assignment (e.g. a mid-session usage-limit auto-switch), so the frontend
  // value can't clobber a more recent worker-side switch.
  const msgAuthProfileId =
    typeof msg.authProfileId === "string" && msg.authProfileId.length > 0
      ? msg.authProfileId
      : undefined;
  if (msgAuthProfileId && !state.tabAuthProfileIds.has(tabId)) {
    state.tabAuthProfileIds.set(tabId, msgAuthProfileId);
  }
  const requestedModel = parseModelAndThinking(
    typeof msg.model === "string" && msg.model.length > 0
      ? msg.model
      : undefined,
    msg.thinkingLevel,
  );
  const modelId = requestedModel.modelId;
  const authServicesRefreshed = refreshAuthServicesForTab(state, tabId, {
    modelId,
  });
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
    cwdOverride || initialModel || requestedModel.thinkingLevel
      ? {
          cwdOverride,
          initialModel,
          thinkingLevel: requestedModel.thinkingLevel,
        }
      : {},
  );
  if (scheduledRun) {
    tab.scheduledRun = scheduledRun;
  }
  chatLog.info(`tab ready tabId=${tabId}`);
  if (authServicesRefreshed) {
    refreshTabSessionModelFromAuthServices(state, tabId);
  }
  if (requestedModel.thinkingLevel) {
    tab.session.setThinkingLevel(requestedModel.thinkingLevel);
  }
  const planMode = state.tabPlanMode.get(tabId) === true;
  const wantsSteer = msg.mode === "steer";
  const images = normalizeImages(msg.images);
  let content: string;
  try {
    const expanded = await expandFileReferencesInPrompt(msg.content, {
      // Same precedence as subagent-mention resolution: honor this turn's
      // cwdOverride first. ensureTab returns early for an existing tab without
      // refreshing tabProjectCwds, so falling back to it alone resolves @file
      // refs against a stale cwd when the caller passed a fresh cwd.
      cwd: tabCwdForMention ?? process.cwd(),
      // Exempt every configured subagent name (not just a leading mention) so a
      // mid-message `@reviewer` is treated as an agent mention, not a file ref.
      subagentNames: tabSubagents.keys(),
    });
    if (expanded.issues?.length) {
      deps.send({
        type: "notice",
        tabId,
        message: `file references: ${expanded.issues.join("\n")}`,
      });
    }
    content = planMode ? withPlanModeInstruction(expanded.prompt) : expanded.prompt;
  } catch (err) {
    if (mentions.length > 0) state.pendingExplicitSubagent.delete(tabId);
    const message =
      err instanceof FileReferenceError
        ? err.issues.join("\n")
        : err instanceof Error
          ? err.message
          : String(err);
    deps.send({
      type: "error",
      tabId,
      message: `file references: ${message}`,
      ...(controlRequestId ? { controlRequestId } : {}),
    });
    completeScheduledRun(deps, tabId, scheduledRun, false, message);
    if (scheduledRun) tab.scheduledRun = undefined;
    return;
  }
  const busyForTurn = tab.promptInFlight || isUnderlyingSessionBusy(tab);
  if (busyForTurn && !tab.promptInFlight) {
    tab.promptInFlight = true;
    tab.agentEndFired = false;
    state.currentAgentTabId = tabId;
  }
  if (wantsSteer && busyForTurn) {
    state.currentAgentTabId = tabId;
    state.tabContext
      .run(tabId, () =>
        images.length > 0
          ? tab.session.steer(content, images)
          : tab.session.steer(content),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "error",
          tabId,
          message: `steer: ${message}`,
          ...(controlRequestId ? { controlRequestId } : {}),
        });
        completeScheduledRun(deps, tabId, scheduledRun, false, message);
        if (scheduledRun) tab.scheduledRun = undefined;
      });
    return;
  }
  const queued = busyForTurn;
  if (queued) {
    tab.queuedCount += 1;
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
        deps.send({
          type: "error",
          tabId,
          message: `followUp: ${message}`,
          ...(controlRequestId ? { controlRequestId } : {}),
        });
        completeScheduledRun(deps, tabId, scheduledRun, false, message);
        if (scheduledRun) tab.scheduledRun = undefined;
      });
    deps.send({ type: "queued", tabId });
    return;
  }

  tab.promptInFlight = true;
  tab.agentEndFired = false;
  state.currentAgentTabId = tabId;
  // Announce the turn start so the frontend's bucket-independent running set
  // (agentRunningTabs) lights up this tab's sidebar dot even when its
  // workspace is backgrounded. Symmetric with the response_end below; without
  // it a normal prompt only shows "running" for the active workspace (which
  // infers it from the optimistic `waiting` flag). `source: "chat"` keeps the
  // handler from running its queue-promotion branch.
  deps.send({
    type: "prompt_started",
    tabId,
    source: "chat",
    ...(controlRequestId ? { controlRequestId } : {}),
  });
  state.tabContext
    .run(tabId, () =>
      images.length > 0
        ? tab.session.prompt(content, { images })
        : tab.session.prompt(content),
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.send({
        type: "error",
        tabId,
        message: `prompt: ${message}`,
        ...(controlRequestId ? { controlRequestId } : {}),
      });
      completeScheduledRun(deps, tabId, scheduledRun, false, message);
      if (scheduledRun) tab.scheduledRun = undefined;
    })
    .finally(() => {
      const stillStreamingOrRetrying = isUnderlyingSessionBusy(tab);
      if (!tab.agentEndFired && !stillStreamingOrRetrying) {
        tab.promptInFlight = false;
        deps.send({
          type: "response_end",
          tabId,
          ...(controlRequestId ? { controlRequestId } : {}),
        });
        completeScheduledRun(deps, tabId, tab.scheduledRun, true);
        tab.scheduledRun = undefined;
      }
      if (state.currentAgentTabId === tabId && !stillStreamingOrRetrying) {
        state.currentAgentTabId = undefined;
      }
      maybeExitForReload(state, deps);
    });
  chatLog.info(`prompt dispatched tabId=${tabId}`);
}

const PLAN_MODE_INSTRUCTION =
  "You are in Aethon plan mode. Do not edit files, run shell commands, start implementation tasks, commit, push, or make persistent changes. Inspect read-only context as needed, then propose a concise implementation plan with risks and tests. Wait for the user to switch back to implementation mode or explicitly approve implementation.";

function withPlanModeInstruction(prompt: string): string {
  return `${PLAN_MODE_INSTRUCTION}\n\nUser request:\n${prompt}`;
}

function scheduledRunFromMessage(
  msg: InboundMessage,
): TabRecord["scheduledRun"] | undefined {
  if (
    typeof msg.scheduledTaskId !== "string" ||
    msg.scheduledTaskId.length === 0 ||
    typeof msg.scheduledRunId !== "string" ||
    msg.scheduledRunId.length === 0
  ) {
    return undefined;
  }
  return { taskId: msg.scheduledTaskId, runId: msg.scheduledRunId };
}

function completeScheduledRun(
  deps: DispatcherDeps,
  tabId: string,
  scheduledRun: TabRecord["scheduledRun"] | undefined,
  success: boolean,
  error?: string,
): void {
  if (!scheduledRun) return;
  deps.send({
    type: "scheduled_task_run_complete",
    tabId,
    taskId: scheduledRun.taskId,
    runId: scheduledRun.runId,
    success,
    ...(error ? { error } : {}),
    ...(scheduledRun.completeRequested ? { completeTask: true } : {}),
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
  const requestedModel = parseModelAndThinking(msg.id, msg.thinkingLevel);
  const authServicesRefreshed = refreshAuthServicesForTab(state, tabId, {
    modelId: requestedModel.modelId,
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
  const modelId = requestedModel.modelId ?? msg.id;
  const [provider, ...rest] = modelId.split("/");
  const id = rest.join("/");
  const next = modelRegistryForModelId(state, tabId, modelId).find(
    provider,
    id,
  );
  if (!next) {
    deps.send({
      type: "error",
      tabId,
      message: `set_model: unknown model ${modelId}`,
    });
    return;
  }
  try {
    await tab.session.setModel(next);
    if (requestedModel.thinkingLevel) {
      tab.session.setThinkingLevel(requestedModel.thinkingLevel);
    }
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
  deps.send(modelStatePayload("model_changed", state, tabId, tab, modelId));
  emitContextUsage(state, deps, tabId, tab);
}

export async function handleSetThinkingLevel(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = msg.tabId ?? "default";
  const level = normalizeThinkingLevel(msg.thinkingLevel ?? msg.value);
  if (!level) {
    deps.send({
      type: "error",
      tabId,
      message: "set_thinking_level: missing or invalid level",
    });
    return;
  }
  const tab = await ensureTab(state, deps, tabId);
  if (tab.promptInFlight) {
    deps.send({
      type: "notice",
      tabId,
      message:
        "agent busy — stop the current prompt before switching reasoning",
    });
    return;
  }
  try {
    tab.session.setThinkingLevel(level);
    state.settingsManager.setDefaultThinkingLevel(level);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "error",
      tabId,
      message: `set_thinking_level: ${message}`,
    });
    return;
  }
  deps.scheduleStateFileWrite();
  deps.send(modelStatePayload("thinking_level_changed", state, tabId, tab));
}

export function handleSetCodexFastMode(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  state.codexFastMode = msg.codexFastMode === true || msg.value === true;
  deps.scheduleStateFileWrite();
  for (const [tabId, tab] of state.tabs) {
    deps.send(modelStatePayload("codex_fast_mode_changed", state, tabId, tab));
  }
}

export function modelStatePayload(
  type: "model_changed" | "thinking_level_changed" | "codex_fast_mode_changed",
  state: AethonAgentState,
  tabId: string,
  tab: TabRecord,
  modelOverride?: string,
): Record<string, unknown> {
  const session = tab.session as TabRecord["session"] & {
    getAvailableThinkingLevels?: () => string[];
    thinkingLevel?: string;
  };
  return {
    type,
    tabId,
    model:
      modelOverride ??
      (session.model ? `${session.model.provider}/${session.model.id}` : ""),
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
    codexFastMode: state.codexFastMode,
    codexFastModeSupported: supportsCodexFastMode(session.model),
  };
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" &&
    THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}

function parseModelAndThinking(
  rawModel: string | undefined,
  rawLevel: unknown,
): { modelId?: string; thinkingLevel?: ThinkingLevel } {
  const explicitLevel = normalizeThinkingLevel(rawLevel);
  if (!rawModel) return explicitLevel ? { thinkingLevel: explicitLevel } : {};
  const idx = rawModel.lastIndexOf(":");
  if (idx <= 0)
    return {
      modelId: rawModel,
      ...(explicitLevel ? { thinkingLevel: explicitLevel } : {}),
    };
  const modelId = rawModel.slice(0, idx);
  const suffix = normalizeThinkingLevel(rawModel.slice(idx + 1));
  if (!modelId.startsWith("openai-codex/") || !suffix)
    return {
      modelId: rawModel,
      ...(explicitLevel ? { thinkingLevel: explicitLevel } : {}),
    };
  return {
    modelId,
    thinkingLevel: explicitLevel ?? suffix,
  };
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
