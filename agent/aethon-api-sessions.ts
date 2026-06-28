import type { Api, Model } from "@mariozechner/pi-ai";
import { stripExpandedFileReferences } from "./file-references";
import type { AethonAgentState, TabRecord } from "./state";
import {
  readSessionTranscript,
  type RestoredChatMessage,
} from "./session-history";
import { textFromContent, thinkingFromContent } from "./session-history/shared";
import { tabSessionDir } from "./tab-lifecycle";

export interface SessionSummary {
  id: string;
  label: string;
  active: boolean;
  model: string;
  cwd?: string;
  messageCount: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionMessage {
  id: string;
  role: "user" | "agent" | "system";
  /** Canonical plain-text body for extension consumers. */
  content: string;
  /** Alias retained for Aethon's chat message shape. */
  text?: string;
  thinking?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  a2ui?: { components: unknown[] };
}

export interface SessionMessageOptions {
  /** Return only the most recent N messages. Values below 1 are ignored. */
  limit?: number;
}

export interface SessionsApi {
  list(): Promise<SessionSummary[]>;
  getActive(): Promise<SessionSummary | null>;
  getMessages(
    sessionId: string,
    options?: SessionMessageOptions,
  ): Promise<SessionMessage[]>;
  getTranscript(
    sessionId: string,
    options?: SessionMessageOptions,
  ): Promise<string>;
  on(event: SessionEventName, handler: SessionEventHandler): () => void;
}

type FrontendTabSummary = {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  cwd?: unknown;
  model?: unknown;
  active?: unknown;
};

export type SessionEventName =
  | "activeChanged"
  | "messageAppended"
  | "messageUpdated"
  | "sessionChanged";

export type SessionEventPayload =
  | { sessionId: string | null; session?: SessionSummary }
  | { sessionId: string; message: SessionMessage }
  | { sessionId: string; messageId: string; message: SessionMessage }
  | { session: SessionSummary };

export type SessionEventHandler = (
  payload: SessionEventPayload,
) => void | Promise<void>;

function sessionMessageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`;
}

function emittedSessionMessageIds(state: AethonAgentState): Set<string> {
  const holder = state as { emittedSessionMessageIds?: Set<string> };
  holder.emittedSessionMessageIds ??= new Set<string>();
  return holder.emittedSessionMessageIds;
}

export function hasEmittedSessionMessage(
  state: AethonAgentState,
  sessionId: string,
  messageId: string,
): boolean {
  return emittedSessionMessageIds(state).has(
    sessionMessageKey(sessionId, messageId),
  );
}

function rememberEmittedMessage(
  state: AethonAgentState,
  payload: SessionEventPayload,
): void {
  if (!("message" in payload) || typeof payload.sessionId !== "string") return;
  emittedSessionMessageIds(state).add(
    sessionMessageKey(payload.sessionId, payload.message.id),
  );
}

function modelKey(model: Model<Api> | undefined): string {
  if (!model) return "";
  return `${model.provider}/${model.id}`;
}

function fallbackLabel(id: string): string {
  return id === "default" ? "Default" : `Session ${id.slice(0, 8)}`;
}

function isAgentFrontendTab(tab: FrontendTabSummary): boolean {
  // Older mirrors did not include `kind`; treat missing as an agent tab for
  // compatibility, but exclude explicit shell/editor tabs from session APIs.
  return tab.kind === undefined || tab.kind === "agent";
}

function frontendTabs(
  state: AethonAgentState,
): Map<string, FrontendTabSummary> {
  const value = state.frontendState.get("/tabs");
  const map = new Map<string, FrontendTabSummary>();
  if (!Array.isArray(value)) return map;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const tab = item as FrontendTabSummary;
    if (typeof tab.id !== "string" || !isAgentFrontendTab(tab)) continue;
    map.set(tab.id, tab);
  }
  return map;
}

function messageCountFor(record: TabRecord | undefined): number {
  return Array.isArray(record?.session.messages)
    ? record.session.messages.length
    : 0;
}

export function listSessionSummaries(
  state: AethonAgentState,
): SessionSummary[] {
  const front = frontendTabs(state);
  const summaries = new Map<string, SessionSummary>();

  for (const [id, tab] of front) {
    const record = state.tabs.get(id);
    const label =
      typeof tab.label === "string" && tab.label
        ? tab.label
        : fallbackLabel(id);
    const cwd =
      typeof tab.cwd === "string"
        ? tab.cwd
        : (state.tabProjectCwds.get(id) ?? undefined);
    summaries.set(id, {
      id,
      label,
      active: tab.active === true,
      model:
        typeof tab.model === "string"
          ? tab.model
          : modelKey(record?.session.model),
      ...(cwd ? { cwd } : {}),
      messageCount: messageCountFor(record),
    });
  }

  for (const [id, record] of state.tabs) {
    const existing = summaries.get(id);
    if (existing) {
      summaries.set(id, {
        ...existing,
        model: existing.model || modelKey(record.session.model),
        messageCount: Math.max(existing.messageCount, messageCountFor(record)),
        ...(state.tabProjectCwds.has(id)
          ? { cwd: state.tabProjectCwds.get(id) }
          : {}),
      });
      continue;
    }
    const cwd = state.tabProjectCwds.get(id);
    summaries.set(id, {
      id,
      label: fallbackLabel(id),
      active: false,
      model: modelKey(record.session.model),
      ...(cwd ? { cwd } : {}),
      messageCount: messageCountFor(record),
    });
  }

  for (const tab of state.discoveredTabs) {
    if (summaries.has(tab.tabId)) continue;
    const label =
      tab.customLabel ?? tab.firstUserMessage ?? fallbackLabel(tab.tabId);
    summaries.set(tab.tabId, {
      id: tab.tabId,
      label,
      active: false,
      model: "",
      ...(tab.cwd ? { cwd: tab.cwd } : {}),
      messageCount: 0,
      updatedAt: tab.lastModified,
    });
  }

  return [...summaries.values()];
}

export function activeSessionSummary(
  state: AethonAgentState,
): SessionSummary | null {
  return listSessionSummaries(state).find((session) => session.active) ?? null;
}

function roleFromPi(role: unknown): SessionMessage["role"] | undefined {
  if (role === "assistant" || role === "agent") return "agent";
  if (role === "user" || role === "system") return role;
  return undefined;
}

function timestampFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const PLAN_MODE_PREFIX =
  "You are in Aethon plan mode. Do not edit files, run shell commands, start implementation tasks, commit, push, or make persistent changes. Inspect read-only context as needed, then propose a concise implementation plan with risks and tests. Wait for the user to switch back to implementation mode or explicitly approve implementation.\n\nUser request:\n";

function visibleUserContent(content: string): string {
  const stripped = stripExpandedFileReferences(content);
  return stripped.startsWith(PLAN_MODE_PREFIX)
    ? stripped.slice(PLAN_MODE_PREFIX.length)
    : stripped;
}

function messageId(record: Record<string, unknown>, index: number): string {
  for (const key of ["id", "messageId", "entryId"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return `message-${index}`;
}

function liveMessageFromPi(raw: unknown, index: number): SessionMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const role = roleFromPi(record.role);
  if (!role) return null;
  const rawContent = textFromContent(record.content);
  const content = role === "user" ? visibleUserContent(rawContent) : rawContent;
  const thinking = thinkingFromContent(record.content);
  if (!content && !thinking) return null;
  const metadata: Record<string, unknown> = {};
  for (const key of ["stopReason", "usage", "model", "provider"]) {
    if (record[key] !== undefined) metadata[key] = record[key];
  }
  const createdAt = timestampFrom(record.createdAt ?? record.timestamp);
  return {
    id: messageId(record, index),
    role,
    content,
    ...(content ? { text: content } : {}),
    ...(thinking ? { thinking } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function messageFromRestored(message: RestoredChatMessage): SessionMessage {
  const content = message.text ?? "";
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.text ? { text: message.text } : {}),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.createdAt !== undefined
      ? { createdAt: message.createdAt }
      : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.a2ui ? { a2ui: message.a2ui } : {}),
  };
}

function applyOptions(
  messages: SessionMessage[],
  options: SessionMessageOptions | undefined,
): SessionMessage[] {
  const limit = options?.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return messages;
  }
  return messages.slice(-Math.floor(limit));
}

function normalizedContentKey(message: SessionMessage): string | undefined {
  const content = message.content.replace(/\s+/g, " ").trim();
  const thinking = message.thinking?.replace(/\s+/g, " ").trim() ?? "";
  if (!content && !thinking) return undefined;
  return `${message.role}\0${content}\0${thinking}`;
}

function activeResponseMessage(
  record: TabRecord | undefined,
): SessionMessage[] {
  if (!record?.activeResponseMessageId) return [];
  const content = record.activeResponseText ?? "";
  const thinking = record.activeResponseThinking ?? "";
  if (!content && !thinking) return [];
  return [
    {
      id: record.activeResponseMessageId,
      role: "agent",
      content,
      ...(content ? { text: content } : {}),
      ...(thinking ? { thinking } : {}),
    },
  ];
}

function enrichMessage(
  base: SessionMessage,
  addition: SessionMessage,
  options: { preferAdditionContent?: boolean } = {},
): SessionMessage {
  const next: SessionMessage = { ...base };
  if (options.preferAdditionContent) {
    next.content = addition.content;
    if (addition.text !== undefined) next.text = addition.text;
    else delete next.text;
    if (addition.thinking !== undefined) next.thinking = addition.thinking;
    else delete next.thinking;
  }
  if (base.createdAt === undefined && addition.createdAt !== undefined) {
    next.createdAt = addition.createdAt;
  }
  if (base.attachments === undefined && addition.attachments !== undefined) {
    next.attachments = addition.attachments;
  }
  if (base.a2ui === undefined && addition.a2ui !== undefined) {
    next.a2ui = addition.a2ui;
  }
  if (base.metadata === undefined && addition.metadata !== undefined) {
    next.metadata = addition.metadata;
  }
  return next;
}

function mergeMessages(
  liveMessages: SessionMessage[],
  restoredMessages: SessionMessage[],
  options: { matchContent?: boolean; preferAdditionContentOnId?: boolean } = {},
): SessionMessage[] {
  if (liveMessages.length === 0) return restoredMessages;
  if (restoredMessages.length === 0) return liveMessages;
  const matchContent = options.matchContent !== false;
  const contentIndex = new Map<string, number[]>();
  const merged = [...liveMessages];
  const idIndex = new Map(merged.map((message, index) => [message.id, index]));
  const consumeContentIndex = (
    key: string | undefined,
    index?: number,
  ): number | undefined => {
    if (!key) return undefined;
    const queue = contentIndex.get(key);
    if (!queue || queue.length === 0) return undefined;
    if (index === undefined) return queue.shift();
    const position = queue.indexOf(index);
    if (position >= 0) queue.splice(position, 1);
    return index;
  };
  if (matchContent) {
    for (let index = 0; index < merged.length; index += 1) {
      const key = normalizedContentKey(merged[index]);
      if (!key) continue;
      const queue = contentIndex.get(key) ?? [];
      queue.push(index);
      contentIndex.set(key, queue);
    }
  }
  for (const restored of restoredMessages) {
    const key = normalizedContentKey(restored);
    const idMatch = idIndex.get(restored.id);
    const existingIndex =
      idMatch ?? (matchContent && key ? consumeContentIndex(key) : undefined);
    if (existingIndex !== undefined) {
      if (idMatch !== undefined) consumeContentIndex(key, existingIndex);
      merged[existingIndex] = enrichMessage(merged[existingIndex], restored, {
        preferAdditionContent:
          options.preferAdditionContentOnId === true && idMatch !== undefined,
      });
      continue;
    }
    idIndex.set(restored.id, merged.length);
    merged.push(restored);
  }
  return merged
    .map((message, order) => ({ message, order }))
    .sort((a, b) => {
      if (
        typeof a.message.createdAt === "number" &&
        typeof b.message.createdAt === "number" &&
        a.message.createdAt !== b.message.createdAt
      ) {
        return a.message.createdAt - b.message.createdAt;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.message);
}

async function messagesForSession(
  state: AethonAgentState,
  sessionId: string,
  options?: SessionMessageOptions,
): Promise<SessionMessage[]> {
  const live = state.tabs.get(sessionId);
  const livePiMessages = Array.isArray(live?.session.messages)
    ? live.session.messages.flatMap((message, index) => {
        const normalized = liveMessageFromPi(message, index);
        return normalized ? [normalized] : [];
      })
    : [];
  const summary = listSessionSummaries(state).find((s) => s.id === sessionId);
  const expectedCwd =
    state.tabProjectCwds.get(sessionId) ?? summary?.cwd ?? undefined;
  const restored = await readSessionTranscript(
    tabSessionDir(state, sessionId),
    expectedCwd,
  );
  const durableMessages = mergeMessages(
    livePiMessages,
    restored.map(messageFromRestored),
  );
  return applyOptions(
    mergeMessages(durableMessages, activeResponseMessage(live), {
      matchContent: false,
      preferAdditionContentOnId: true,
    }),
    options,
  );
}

function transcriptFromMessages(messages: SessionMessage[]): string {
  return messages
    .map((message) => {
      const title =
        message.role === "agent"
          ? "Agent"
          : message.role[0].toUpperCase() + message.role.slice(1);
      const chunks: string[] = [];
      if (message.thinking)
        chunks.push(
          `> Thinking\n>\n${message.thinking
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`,
        );
      if (message.content) chunks.push(message.content);
      if (!message.content && message.a2ui) chunks.push("[A2UI content]");
      if (!chunks.length) chunks.push("[empty]");
      return `## ${title}\n\n${chunks.join("\n\n")}`;
    })
    .join("\n\n");
}

export function emitSessionEvent(
  state: AethonAgentState,
  event: SessionEventName,
  payload: SessionEventPayload,
): void {
  const registry = (
    state as { sessionEventHandlers?: AethonAgentState["sessionEventHandlers"] }
  ).sessionEventHandlers;
  rememberEmittedMessage(state, payload);
  const handlers = registry?.get(event) as Set<SessionEventHandler> | undefined;
  if (!handlers || handlers.size === 0) return;
  for (const handler of handlers) {
    queueMicrotask(() => {
      try {
        Promise.resolve(handler(payload)).catch(() => {
          // Extension event handlers should not break bridge/session flow.
        });
      } catch {
        // Extension event handlers should not break bridge/session flow.
      }
    });
  }
}

function activeAgentIdFromMirroredTabs(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const tab = item as FrontendTabSummary;
    if (
      tab.active === true &&
      typeof tab.id === "string" &&
      isAgentFrontendTab(tab)
    ) {
      return tab.id;
    }
  }
  return undefined;
}

function mirroredAgentTabsById(
  value: unknown,
): Map<string, FrontendTabSummary> {
  const tabs = new Map<string, FrontendTabSummary>();
  if (!Array.isArray(value)) return tabs;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const tab = item as FrontendTabSummary;
    if (typeof tab.id === "string" && isAgentFrontendTab(tab)) {
      tabs.set(tab.id, tab);
    }
  }
  return tabs;
}

function sessionMetadataChanged(
  previous: FrontendTabSummary | undefined,
  next: FrontendTabSummary,
): boolean {
  if (!previous) return true;
  return (
    previous.label !== next.label ||
    previous.model !== next.model ||
    previous.cwd !== next.cwd ||
    previous.active !== next.active
  );
}

export function handleMirroredTabsChanged(
  state: AethonAgentState,
  previous: unknown,
  next: unknown,
): void {
  if (!Array.isArray(next)) return;
  const previousActive = activeAgentIdFromMirroredTabs(previous);
  const nextActive = activeAgentIdFromMirroredTabs(next);
  if (previousActive !== nextActive) {
    const session =
      typeof nextActive === "string"
        ? listSessionSummaries(state).find((s) => s.id === nextActive)
        : undefined;
    emitSessionEvent(state, "activeChanged", {
      sessionId: typeof nextActive === "string" ? nextActive : null,
      ...(session ? { session } : {}),
    });
  }
  const previousTabs = mirroredAgentTabsById(previous);
  for (const item of next) {
    if (!item || typeof item !== "object") continue;
    const tab = item as FrontendTabSummary;
    if (typeof tab.id !== "string" || !isAgentFrontendTab(tab)) continue;
    if (!sessionMetadataChanged(previousTabs.get(tab.id), tab)) continue;
    const session = listSessionSummaries(state).find((s) => s.id === tab.id);
    if (session) emitSessionEvent(state, "sessionChanged", { session });
  }
}

function sessionEventHandlerKey(
  state: AethonAgentState,
  event: SessionEventName,
  handler: SessionEventHandler,
): string | undefined {
  if (!state.currentExtensionName || !state.currentExtensionLoadScope) {
    return undefined;
  }
  const scope = `${state.currentExtensionLoadScope}:${state.currentExtensionName}`;
  const base = `sessions:on::${scope}::${event}::${handler.toString()}`;
  const ordinal = state.currentExtensionHandlerOrdinals.get(base) ?? 0;
  state.currentExtensionHandlerOrdinals.set(base, ordinal + 1);
  return `${base}::${ordinal}`;
}

export function buildSessionsApi(state: AethonAgentState): SessionsApi {
  return {
    list: () => Promise.resolve(listSessionSummaries(state)),
    getActive: () => Promise.resolve(activeSessionSummary(state)),
    getMessages: async (sessionId, options) => {
      if (typeof sessionId !== "string" || sessionId.length === 0) return [];
      return messagesForSession(state, sessionId, options);
    },
    getTranscript: async (sessionId, options) => {
      if (typeof sessionId !== "string" || sessionId.length === 0) return "";
      return transcriptFromMessages(
        await messagesForSession(state, sessionId, options),
      );
    },
    on(event: SessionEventName, handler: SessionEventHandler) {
      if (typeof handler !== "function") return () => {};
      const key = sessionEventHandlerKey(state, event, handler);
      if (key && state.registeredHandlerKeys.has(key)) {
        const existingOff = state.sessionEventHandlerTeardowns.get(key);
        if (existingOff) return existingOff;
        state.registeredHandlerKeys.delete(key);
      }
      if (key) state.registeredHandlerKeys.add(key);
      let handlers = state.sessionEventHandlers.get(event) as
        | Set<SessionEventHandler>
        | undefined;
      if (!handlers) {
        handlers = new Set<SessionEventHandler>();
        state.sessionEventHandlers.set(event, handlers);
      }
      handlers.add(handler);
      const off = () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) state.sessionEventHandlers.delete(event);
        if (key) {
          state.registeredHandlerKeys.delete(key);
          state.sessionEventHandlerTeardowns.delete(key);
        }
      };
      if (key) state.sessionEventHandlerTeardowns.set(key, off);
      if (state.currentExtensionLoadScope === "project") {
        state.projectExtensionTeardowns.push(off);
      } else if (state.currentExtensionLoadScope === "user") {
        state.userExtensionTeardowns.push(off);
      }
      return off;
    },
  };
}
