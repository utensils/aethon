import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState, AethonExtensionApi } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { emitGlobalReady } from "./dispatcherTypes";
import { loadProjectAethonExtensions } from "./extension-loader";
import {
  appendLocalChatMessage,
  hasA2ui,
  parseChatAttachments,
  readSessionTranscript,
} from "./session-history";
import { ensureTab, tabSessionDir } from "./tab-lifecycle";
import { unloadProjectExtensions } from "./projectLifecycle";
import { modelRegistryForModelId } from "./auth-profiles";
import { clearPendingContextUsageEmit } from "./context-usage";
import {
  emitSessionEvent,
  hasEmittedSessionMessage,
} from "./aethon-api-sessions";
import { setSessionLabelForTab } from "./session-label";

export async function handleTabOpen(
  state: AethonAgentState,
  deps: DispatcherDeps,
  extensionApi: AethonExtensionApi,
  msg: InboundMessage,
): Promise<void> {
  const tabId = msg.tabId;
  if (!tabId || typeof tabId !== "string") {
    deps.send({ type: "error", message: "tab_open: missing tabId" });
    return;
  }
  const authProfileId = (msg as { authProfileId?: unknown }).authProfileId;
  if (typeof authProfileId === "string" && authProfileId.length > 0) {
    state.tabAuthProfileIds.set(tabId, authProfileId);
  }
  const modelRequest = parseModelAndThinking(
    (msg as { model?: unknown }).model,
    (msg as { thinkingLevel?: unknown }).thinkingLevel,
  );
  let initialModel: Model<Api> | undefined;
  if (modelRequest.modelId) {
    const [provider, ...rest] = modelRequest.modelId.split("/");
    initialModel =
      modelRegistryForModelId(state, tabId, modelRequest.modelId).find(
        provider,
        rest.join("/"),
      ) ?? undefined;
  }
  const cwdField = (msg as { cwd?: unknown }).cwd;
  const cwdOverride =
    typeof cwdField === "string" && cwdField.length > 0 ? cwdField : undefined;
  if (cwdOverride) {
    const projectChanged = cwdOverride !== state.currentProjectCwd;
    if (projectChanged) {
      unloadProjectExtensions(state, deps);
    }
    const result = await loadProjectAethonExtensions(
      state,
      deps,
      cwdOverride,
      extensionApi,
      state.loadedExtensions,
      state.loadedProjectExtensionFiles,
      state.failedProjectExtensionFiles,
      deps.loadHooks,
    );
    state.currentProjectCwd = cwdOverride;
    if (
      result.loaded > 0 ||
      result.failed > 0 ||
      result.prunedDisabled > 0 ||
      projectChanged
    ) {
      await state.resourceLoader.reload();
      deps.scheduleStateFileWrite();
      await emitGlobalReady(state, deps);
    }
  }
  const restoreHistory =
    (msg as { restoreHistory?: unknown }).restoreHistory === true;
  let restoredMessages: Awaited<ReturnType<typeof readSessionTranscript>> = [];
  if (restoreHistory) {
    try {
      const expectedCwd =
        cwdOverride ??
        state.tabProjectCwds.get(tabId) ??
        (tabId === "default"
          ? (state.currentProjectCwd ?? process.cwd())
          : undefined);
      restoredMessages = await readSessionTranscript(
        tabSessionDir(state, tabId),
        expectedCwd,
      );
    } catch (err) {
      deps.send({
        type: "error",
        tabId,
        message: `session restore: ${(err as Error).message}`,
      });
    }
  }
  const tab = await ensureTab(state, deps, tabId, {
    initialModel,
    cwdOverride,
    thinkingLevel: modelRequest.thinkingLevel,
  });
  if (modelRequest.thinkingLevel) {
    tab.session.setThinkingLevel(modelRequest.thinkingLevel);
  }
  if (restoreHistory) {
    deps.send({ type: "session_history", tabId, messages: restoredMessages });
  }
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
  rawModel: unknown,
  rawLevel: unknown,
): { modelId?: string; thinkingLevel?: ThinkingLevel } {
  const explicitLevel = normalizeThinkingLevel(rawLevel);
  if (typeof rawModel !== "string" || rawModel.length === 0) {
    return explicitLevel ? { thinkingLevel: explicitLevel } : {};
  }
  const idx = rawModel.lastIndexOf(":");
  if (idx <= 0) {
    return {
      modelId: rawModel,
      ...(explicitLevel ? { thinkingLevel: explicitLevel } : {}),
    };
  }
  const modelId = rawModel.slice(0, idx);
  const suffix = normalizeThinkingLevel(rawModel.slice(idx + 1));
  if (!modelId.startsWith("openai-codex/") || !suffix) {
    return {
      modelId: rawModel,
      ...(explicitLevel ? { thinkingLevel: explicitLevel } : {}),
    };
  }
  return {
    modelId,
    thinkingLevel: explicitLevel ?? suffix,
  };
}

export function handleTabClose(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): void {
  const tabId = msg.tabId;
  if (!tabId || typeof tabId !== "string") {
    deps.send({ type: "error", message: "tab_close: missing tabId" });
    return;
  }
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (tab.promptInFlight) {
    tab.session.abort().catch(() => {
      /* fire-and-forget - we're tearing down anyway */
    });
  }
  clearPendingContextUsageEmit(tab);
  state.tabs.delete(tabId);
  state.tabProjectCwds.delete(tabId);
  state.tabAuthProfileIds.delete(tabId);
  if (state.currentAgentTabId === tabId) {
    state.currentAgentTabId = undefined;
  }
  deps.send({ type: "tab_closed", tabId });
}

export async function handleSetSessionLabel(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = (msg as { tabId?: unknown }).tabId;
  const labelField = (msg as { label?: unknown }).label;
  if (typeof tabId !== "string" || !tabId) {
    deps.send({
      type: "error",
      message: "set_session_label: tabId required",
    });
    return;
  }
  const label = typeof labelField === "string" ? labelField : "";
  const ownerCwdField = (msg as { cwd?: unknown }).cwd;
  const ownerCwd =
    typeof ownerCwdField === "string" && ownerCwdField.length > 0
      ? ownerCwdField
      : undefined;
  try {
    await setSessionLabelForTab(state, deps, tabId, label, {
      ...(ownerCwd ? { ownerCwd } : {}),
    });
  } catch (err) {
    deps.send({
      type: "error",
      message: `set_session_label: ${(err as Error).message}`,
    });
    return;
  }
  await emitGlobalReady(state, deps);
}

export async function handleLocalChatMessage(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = msg.tabId ?? "default";
  const payload = msg.payload;
  if (!payload || typeof payload !== "object") {
    deps.send({
      type: "notice",
      tabId,
      message: "local_chat_message: missing payload",
    });
    return;
  }
  const record = payload as Record<string, unknown>;
  const role = record.role;
  const text = record.text;
  const thinking = record.thinking;
  const attachments = parseChatAttachments(record.attachments);
  const a2ui = hasA2ui(record.a2ui) ? record.a2ui : undefined;
  if (role !== "user" && role !== "agent" && role !== "system") {
    deps.send({
      type: "notice",
      tabId,
      message: "local_chat_message: invalid role",
    });
    return;
  }
  const hasText = typeof text === "string" && text.length > 0;
  const hasThinking = typeof thinking === "string" && thinking.length > 0;
  if (!hasText && !hasThinking && !a2ui && attachments.length === 0) {
    deps.send({
      type: "notice",
      tabId,
      message: "local_chat_message: empty message",
    });
    return;
  }
  try {
    const localCwd =
      state.tabProjectCwds.get(tabId) ??
      (tabId === "default"
        ? (state.currentProjectCwd ?? process.cwd())
        : undefined);
    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : randomUUID();
    const persisted = {
      id,
      role,
      ...(hasText ? { text } : {}),
      ...(hasThinking ? { thinking } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(a2ui ? { a2ui } : {}),
      ...(localCwd ? { cwd: localCwd } : {}),
      ...(typeof record.createdAt === "number"
        ? { createdAt: record.createdAt }
        : {}),
    };
    await appendLocalChatMessage(tabSessionDir(state, tabId), persisted);
    if (hasEmittedSessionMessage(state, tabId, id)) return;
    emitSessionEvent(state, "messageAppended", {
      sessionId: tabId,
      message: {
        id,
        role,
        content: hasText ? text : "",
        ...(hasText ? { text } : {}),
        ...(hasThinking ? { thinking } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(a2ui ? { a2ui } : {}),
        ...(typeof record.createdAt === "number"
          ? { createdAt: record.createdAt }
          : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.send({
      type: "notice",
      tabId,
      message: `local chat persist failed: ${message}`,
    });
  }
}
