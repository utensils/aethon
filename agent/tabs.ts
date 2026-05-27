import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AethonAgentState, AethonExtensionApi } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { emitGlobalReady } from "./dispatcherTypes";
import { loadProjectAethonExtensions } from "./extension-loader";
import {
  appendLocalChatMessage,
  readSessionMetadata,
  readSessionTranscript,
  writeSessionLabel,
} from "./session-history";
import { ensureTab, tabSessionDir } from "./tab-lifecycle";
import { unloadProjectExtensions } from "./projectLifecycle";
import { modelRegistryForModelId } from "./auth-profiles";

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
  const modelId = (msg as { model?: unknown }).model;
  let initialModel: Model<Api> | undefined;
  if (typeof modelId === "string" && modelId.length > 0) {
    const [provider, ...rest] = modelId.split("/");
    initialModel =
      modelRegistryForModelId(state, tabId, modelId).find(
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
    if (result.loaded > 0 || result.failed > 0 || projectChanged) {
      await state.resourceLoader.reload();
      deps.scheduleStateFileWrite();
      emitGlobalReady(state, deps);
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
  await ensureTab(state, deps, tabId, { initialModel, cwdOverride });
  if (restoreHistory) {
    deps.send({ type: "session_history", tabId, messages: restoredMessages });
  }
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
  try {
    await writeSessionLabel(tabSessionDir(state, tabId), label);
  } catch (err) {
    deps.send({
      type: "error",
      message: `set_session_label: ${(err as Error).message}`,
    });
    return;
  }
  // Refresh the discovered-tabs cache so the next emitReady (which the
  // frontend triggers by sending `report` after this command finishes)
  // reflects the new label. Cheap to re-read just the one entry.
  const refreshed = await readSessionMetadata(tabSessionDir(state, tabId));
  if (refreshed) {
    const idx = state.discoveredTabs.findIndex((t) => t.tabId === tabId);
    const entry = { tabId, ...refreshed };
    if (idx >= 0) state.discoveredTabs[idx] = entry;
    else state.discoveredTabs.push(entry);
  }
  emitGlobalReady(state, deps);
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
  if (!hasText && !hasThinking) {
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
    await appendLocalChatMessage(tabSessionDir(state, tabId), {
      id:
        typeof record.id === "string" && record.id.length > 0
          ? record.id
          : randomUUID(),
      role,
      ...(hasText ? { text } : {}),
      ...(hasThinking ? { thinking } : {}),
      ...(localCwd ? { cwd: localCwd } : {}),
      ...(typeof record.createdAt === "number"
        ? { createdAt: record.createdAt }
        : {}),
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
