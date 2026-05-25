/**
 * Multi-tab session lifecycle.
 *
 * Each tab owns its own pi `AgentSession` plus a per-turn state machine
 * (in-flight tracking, queue count, tool-args cache for end-state cards).
 * Sessions share authStorage / modelRegistry / settingsManager /
 * resourceLoader so they all see the same models and extension surface
 * — only message history and active turn are isolated.
 *
 * Tabs are created lazily on first inbound message for a tabId. The
 * frontend always sends tabId; legacy callers without it default to
 * "default". Closing a tab aborts its in-flight prompt and drops the
 * session reference.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { buildShellTools } from "./shell-tools";
import { buildDashboardTools } from "./dashboard-tools";
import { wrapWithSourceGuard } from "./source-guard";
import { logger } from "./logger";
import { extractAgentEndError } from "./agent-errors";
import { findSessionFileMatchingCwd } from "./session-history";
import { consumeBashTerminalSnapshot } from "./terminal-stream";
import {
  extractToolContent,
  summarizeToolArgs,
  toolCardPayload,
} from "./tool-card";
import type {
  AethonAgentState,
  RegisteredPiSlashCommand,
  ModelDescriptor,
  TabRecord,
} from "./state";
export {
  extractToolContent,
  inferToolResultLanguage,
  summarizeToolArgs,
  toolCardPayload,
} from "./tool-card";

const TERMINAL_MAX_BYTES = 64 * 1024;
const TERMINAL_CHUNK_BYTES = 8 * 1024;

const turnLog = logger.scope("turn");

export interface TabLifecycleDeps {
  send: (obj: Record<string, unknown>) => void;
}

export function modelKey(m: Model<Api>): string {
  return `${m.provider}/${m.id}`;
}

export function modelDescriptor(m: Model<Api>): ModelDescriptor {
  return {
    id: modelKey(m),
    label: m.name ?? m.id,
    provider: m.provider,
  };
}

/** Compile a pi-style enabledModels glob ("anthropic/claude-*") into a
 *  RegExp rooted at the model key. Only `*` is treated as a wildcard
 *  (matches any chars except `/`); everything else is escaped literally. */
export function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWild = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${withWild}$`);
}

/** Sanitize a tabId for use as a directory name on disk. */
export function tabSessionDir(state: AethonAgentState, tabId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(tabId) ? tabId : "_unsafe";
  return join(state.sessionsDir, safe);
}

/** Format and forward bash output to the terminal panel in chunks. Caps
 *  a single emit at TERMINAL_MAX_BYTES (trailing window). */
export function emitBashResult(
  deps: TabLifecycleDeps,
  text: string,
  tabId: string,
): void {
  if (!text) return;
  let body = text;
  let truncated = false;
  if (body.length > TERMINAL_MAX_BYTES) {
    body = body.slice(body.length - TERMINAL_MAX_BYTES);
    truncated = true;
  }
  if (truncated) {
    deps.send({
      type: "terminal_output",
      tabId,
      content: `\r\n[…output truncated to last ${TERMINAL_MAX_BYTES} bytes]\r\n`,
    });
  }
  const normalized = body.replace(/\r?\n/g, "\r\n");
  for (let i = 0; i < normalized.length; i += TERMINAL_CHUNK_BYTES) {
    deps.send({
      type: "terminal_output",
      tabId,
      content: normalized.slice(i, i + TERMINAL_CHUNK_BYTES),
    });
  }
}

/** Stop visible timers for tools that were in-flight when the user aborted.
 *  Pi normally emits tool_execution_end, but abort paths can terminate the
 *  turn before that event reaches us. Re-emitting the same tool-card id with
 *  endedAt freezes the frontend clock immediately; if pi later sends the real
 *  end event, that result updates the same card instead of duplicating it. */
export function cancelRunningToolCards(
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
): number {
  const endedAt = Date.now();
  let count = 0;
  for (const [toolCallId, cached] of rec.toolArgsCache) {
    if (cached.startedAt === undefined || cached.endedAt !== undefined) {
      continue;
    }
    cached.endedAt = endedAt;
    cached.status = "cancelled";
    count += 1;
    const payload = toolCardPayload({
      id: cached.uiId,
      toolName: cached.name,
      argsSummary: cached.summary,
      result: "Cancelled by user.",
      status: "cancelled",
      startedAt: cached.startedAt,
      endedAt,
    });
    deps.send({ type: "a2ui", tabId, id: cached.uiId, payload });
    if (cached.name === "bash") {
      deps.send({
        type: "terminal_output",
        tabId,
        content: "\r\n[command cancelled]\r\n",
      });
    }
    turnLog.debug(`cancelled running tool-card ${toolCallId} tabId=${tabId}`);
  }
  return count;
}

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

export function emitReady(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
): void {
  const commandSourceTab =
    state.tabs.get("default") ?? state.tabs.values().next().value;
  if (commandSourceTab) {
    refreshPiSlashCommands(state, commandSourceTab.session);
  }
  deps.send({
    type: "ready",
    model: defaultModelKey(state),
    projectRoot: state.projectRoot,
    currentProjectCwd: state.currentProjectCwd,
    userDir: state.userDir,
    models: state.cachedModels,
    tabs: [...state.tabs.values()].map((t) => ({
      id: t.id,
      model: t.session.model ? modelKey(t.session.model) : "",
      cwd: state.tabProjectCwds.get(t.id),
    })),
    extensionComponents: Object.fromEntries(state.extensionComponents),
    extensionState: state.extensionStateTree,
    extensionStateKeys: [...state.extensionStateKeys],
    extensionTabState: Object.fromEntries(state.perTabExtState),
    extensionLayout: state.extensionLayout,
    extensionLayoutPatches: state.pendingLayoutPatches,
    extensionThemes: [...state.extensionThemes.values()],
    extensionSlashCommands: [...state.extensionSlashCommands.values()],
    piSlashCommands: state.piSlashCommands,
    piSkills: state.piSkills,
    extensionKeybindings: [...state.extensionKeybindings.values()],
    extensionMenuItems: [...state.extensionMenuItems.values()],
    extensionEventRoutes: [...state.extensionEventRoutes.values()],
    extensionEventRoutingMode: state.eventRoutingMode,
    extensionLayouts: [...state.extensionLayouts.values()],
    extensionFrontendModules: [...state.extensionFrontendModules.values()].map(
      (m) => ({
        name: m.name,
        code: m.code,
      }),
    ),
    extensionsList: [...state.loadedExtensions.entries()].map(
      ([name, source]) => ({
        name,
        source,
        ...(source === "project-directory"
          ? { projectRoot: state.projectExtensionRoots.get(name) }
          : {}),
      }),
    ),
    failedExtensionsList: [...state.loadFailures.entries()].map(
      ([name, info]) => ({
        name,
        source: info.source,
        error: info.error,
        ...(info.path ? { path: info.path } : {}),
        ...(info.projectRoot ? { projectRoot: info.projectRoot } : {}),
      }),
    ),
    disabledExtensionsList: [...state.disabledExtensions].sort().map((name) => {
      const meta = state.disabledExtensionMeta.get(name);
      if (!meta) return { name };
      return meta.projectRoot
        ? { name, source: meta.source, projectRoot: meta.projectRoot }
        : { name, source: meta.source };
    }),
    discoveredTabs: state.discoveredTabs,
  });
}

function samePiSlashCommands(
  a: RegisteredPiSlashCommand[],
  b: RegisteredPiSlashCommand[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    return (
      left.name === right?.name &&
      left.description === right.description &&
      left.usage === right.usage &&
      left.source === right.source
    );
  });
}

let warnedMissingExtensionRunner = false;

export function collectPiSlashCommands(
  state: AethonAgentState,
  session: TabRecord["session"],
): RegisteredPiSlashCommand[] {
  const seen = new Set<string>();
  const out: RegisteredPiSlashCommand[] = [];
  const push = (cmd: RegisteredPiSlashCommand) => {
    const name = typeof cmd.name === "string" ? cmd.name.trim() : "";
    if (!/^[A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?$/.test(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      description: cmd.description || "",
      ...(cmd.usage ? { usage: cmd.usage } : {}),
      ...(cmd.source ? { source: cmd.source } : {}),
      ...(cmd.sourceInfo ? { sourceInfo: cmd.sourceInfo } : {}),
    });
  };

  const runner = (
    session as {
      _extensionRunner?: {
        getRegisteredCommands?: () => {
          invocationName?: string;
          description?: string;
          sourceInfo?: unknown;
        }[];
      };
    }
  )._extensionRunner;
  if (!runner && !warnedMissingExtensionRunner) {
    warnedMissingExtensionRunner = true;
    logger
      .scope("slash")
      .warn(
        "pi extension command discovery is using a private session API; _extensionRunner is unavailable",
      );
  }
  // TODO: switch extension command discovery to pi's public API once exposed.
  for (const command of runner?.getRegisteredCommands?.() ?? []) {
    push({
      name: command.invocationName ?? "",
      description: command.description ?? "",
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }

  for (const template of session.promptTemplates ?? []) {
    push({
      name: template.name,
      description: template.description ?? "",
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }

  const skills =
    (
      state.resourceLoader as
        | {
            getSkills?: () => {
              skills: {
                name: string;
                description?: string;
                sourceInfo?: unknown;
              }[];
            };
          }
        | undefined
    )?.getSkills?.().skills ?? [];
  for (const skill of skills) {
    push({
      name: `skill:${skill.name}`,
      description: skill.description ?? "",
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }

  return out;
}

export function refreshPiSlashCommands(
  state: AethonAgentState,
  session: TabRecord["session"],
): void {
  const next = collectPiSlashCommands(state, session);
  if (!samePiSlashCommands(state.piSlashCommands, next)) {
    state.piSlashCommands = next;
    state.piSkills = next
      .filter((c) => c.source === "skill" && c.name.startsWith("skill:"))
      .map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.usage ? { usage: c.usage } : {}),
      }));
  }
}

export interface EnsureTabOptions {
  initialModel?: Model<Api>;
  cwdOverride?: string;
}

/** Create (or fetch) the session record for a tabId. Subscribes to its
 *  pi session and tags every per-turn event with tabId so the frontend
 *  routes deltas / tool cards / response_end to the right tab. */
export async function ensureTab(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  tabId: string,
  options: EnsureTabOptions = {},
): Promise<TabRecord> {
  const existing = state.tabs.get(tabId);
  if (existing) return existing;

  const resolvedCwd =
    options.cwdOverride ??
    state.tabProjectCwds.get(tabId) ??
    state.currentProjectCwd ??
    state.userDir ??
    process.cwd();
  if (options.cwdOverride || !state.tabProjectCwds.has(tabId)) {
    state.tabProjectCwds.set(tabId, resolvedCwd);
  }

  let sessionManager;
  try {
    const dir = tabSessionDir(state, tabId);
    mkdirSync(dir, { recursive: true });
    // Sessions are stored per-tabId, but `default` is shared across
    // every project bucket — a plain `continueRecent` would resume
    // whichever project last wrote there, leaking the wrong chat into
    // a freshly-opened project. Open the most-recent session whose
    // header cwd matches the active project; if none matches, start
    // fresh under the same dir rather than picking up an unrelated
    // project's history (`continueRecent` would).
    const matching = await findSessionFileMatchingCwd(dir, resolvedCwd);
    sessionManager = matching
      ? SessionManager.open(matching, dir)
      : SessionManager.create(resolvedCwd, dir);
  } catch (err) {
    logger
      .scope("session")
      .warn(
        `persistent setup for tab ${tabId} failed (${
          (err as Error).message
        }); falling back to in-memory`,
      );
    sessionManager = SessionManager.inMemory();
  }

  const { session } = await createAgentSession({
    authStorage: state.authStorage,
    modelRegistry: state.modelRegistry,
    settingsManager: state.settingsManager,
    sessionManager,
    resourceLoader: state.resourceLoader,
    customTools: [...buildShellTools(), ...buildDashboardTools()],
    ...(options.initialModel ? { model: options.initialModel } : {}),
  });
  wrapWithSourceGuard(session.agent, state.projectRoot);

  const rec: TabRecord = {
    id: tabId,
    session,
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
  };
  state.tabs.set(tabId, rec);
  refreshPiSlashCommands(state, session);

  // First tab: populate the global picker now that we have a model.
  if (state.cachedModels.length === 0) {
    state.cachedModels = buildPickerModels(state, session.model).map(
      modelDescriptor,
    );
  } else {
    ensurePickerHasModel(state, deps, session.model ?? undefined);
  }

  // Per-tab subscriber. Closes over rec so increments / clears stay
  // local; closes over tabId so outbound events carry routing.
  session.subscribe((event) => {
    handleSessionEvent(state, deps, rec, tabId, event);
  });

  deps.send({
    type: "tab_ready",
    tabId,
    model: session.model ? modelKey(session.model) : "",
  });

  return rec;
}

/** Per-tab pi session event subscriber. Extracted so tests can drive it
 *  directly with synthetic event payloads. */
function handleSessionEvent(
  state: AethonAgentState,
  deps: TabLifecycleDeps,
  rec: TabRecord,
  tabId: string,
  // Pi's event union is large and changes between versions; widen here so
  // the dispatch stays tight in the bridge without coupling to its
  // exhaustive shape.
  event: { type: string } & Record<string, unknown>,
): void {
  switch (event.type) {
    case "agent_start": {
      state.currentAgentTabId = tabId;
      state.turnStartTimes.set(tabId, Date.now());
      const model = rec.session.model ? modelKey(rec.session.model) : "unknown";
      turnLog.info(`start model=${model} tabId=${tabId}`);
      if (rec.queuedCount > 0) {
        rec.queuedCount -= 1;
        // The previous agent_end cleared promptInFlight, but pi has
        // already started the queue-drained turn — re-mark in-flight so
        // a follow-up chat / set_model on this tab queues correctly
        // instead of being treated as a fresh idle prompt.
        rec.promptInFlight = true;
        rec.agentEndFired = false;
        deps.send({
          type: "prompt_started",
          tabId,
          source: "queue",
          queued: rec.queuedCount,
        });
      }
      break;
    }
    case "message_update": {
      const ame = (
        event as { assistantMessageEvent?: { type?: string; delta?: string } }
      ).assistantMessageEvent;
      const channel =
        ame?.type === "thinking_delta" || ame?.type === "reasoning_delta"
          ? "thinking"
          : "text";
      if (
        ame?.type === "text_delta" ||
        ame?.type === "thinking_delta" ||
        ame?.type === "reasoning_delta"
      ) {
        const delta = ame.delta ?? "";
        if (delta) {
          const ts =
            (event as { message?: { timestamp?: number } }).message
              ?.timestamp ?? 0;
          const messageId = `text-${ts}`;
          deps.send({
            type: "response_delta",
            tabId,
            messageId,
            content: delta,
            channel,
          });
        }
      }
      break;
    }
    case "tool_execution_start": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        args: unknown;
      };
      const summary = summarizeToolArgs(ev.toolName, ev.args);
      const startedAt = Date.now();
      const uiId = `tool-${++rec.toolCardSeq}-${ev.toolCallId}`;
      rec.toolArgsCache.set(ev.toolCallId, {
        name: ev.toolName,
        summary,
        uiId,
        startedAt,
      });
      const payload = toolCardPayload({
        id: uiId,
        toolName: ev.toolName,
        argsSummary: summary,
        startedAt,
      });
      deps.send({ type: "a2ui", tabId, id: uiId, payload });
      if (ev.toolName === "bash") {
        const cmd = String(
          (ev.args as { command?: unknown } | undefined)?.command ?? "",
        );
        const echoed = cmd.replace(/\r?\n/g, "\r\n");
        deps.send({
          type: "terminal_output",
          tabId,
          content: `\r\n$ ${echoed}\r\n`,
        });
      }
      break;
    }
    case "tool_execution_update": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        args: unknown;
        partialResult: unknown;
      };
      if (ev.toolName === "bash") {
        let cached = rec.toolArgsCache.get(ev.toolCallId);
        if (!cached) {
          cached = {
            name: ev.toolName,
            summary: summarizeToolArgs(ev.toolName, ev.args),
            uiId: `tool-${++rec.toolCardSeq}-${ev.toolCallId}`,
          };
          rec.toolArgsCache.set(ev.toolCallId, cached);
        }
        const extracted = extractToolContent(ev.partialResult);
        const streamed = consumeBashTerminalSnapshot(
          extracted.text,
          cached.bashStream,
        );
        cached.bashStream = streamed.state;
        emitBashResult(deps, streamed.delta, tabId);
      }
      break;
    }
    case "tool_execution_end": {
      const ev = event as {
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError?: boolean;
      };
      const cached = rec.toolArgsCache.get(ev.toolCallId);
      const uiId = cached?.uiId ?? `tool-${++rec.toolCardSeq}-${ev.toolCallId}`;
      const payload = toolCardPayload({
        id: uiId,
        toolName: ev.toolName,
        argsSummary: cached?.summary ?? "",
        result: ev.result,
        isError: ev.isError,
        ...(cached?.status !== undefined ? { status: cached.status } : {}),
        ...(cached?.startedAt !== undefined
          ? {
              startedAt: cached.startedAt,
              endedAt: cached.endedAt ?? Date.now(),
            }
          : {}),
      });
      deps.send({ type: "a2ui", tabId, id: uiId, payload });
      if (ev.toolName === "bash") {
        const extracted = extractToolContent(ev.result);
        const streamed = consumeBashTerminalSnapshot(
          extracted.text,
          cached?.bashStream,
        );
        emitBashResult(deps, streamed.delta, tabId);
        deps.send({ type: "terminal_output", tabId, content: "\r\n" });
      }
      rec.toolArgsCache.delete(ev.toolCallId);
      break;
    }
    case "agent_end": {
      const messages = (event as { messages?: unknown[] }).messages;
      const failedMessage = extractAgentEndError(messages);
      if (failedMessage) {
        deps.send({ type: "error", tabId, message: failedMessage });
      }
      const startMs = state.turnStartTimes.get(tabId);
      state.turnStartTimes.delete(tabId);
      const durationMs = startMs !== undefined ? Date.now() - startMs : -1;
      const modelStr = rec.session.model
        ? modelKey(rec.session.model)
        : "unknown";
      const lastAssistant = [
        ...((messages ?? []) as { role?: string; stopReason?: string }[]),
      ]
        .reverse()
        .find((m) => m.role === "assistant");
      const reason = lastAssistant?.stopReason ?? "unknown";
      const log = `end model=${modelStr} tabId=${tabId} durationMs=${durationMs} stopReason=${reason}`;
      if (reason === "error") {
        turnLog.warn(log);
      } else {
        turnLog.info(log);
      }
      for (const [toolCallId, cached] of rec.toolArgsCache) {
        if (cached.endedAt !== undefined) rec.toolArgsCache.delete(toolCallId);
      }
      rec.agentEndFired = true;
      rec.promptInFlight = false;
      if (state.currentAgentTabId === tabId) {
        state.currentAgentTabId = undefined;
      }
      deps.send({ type: "response_end", tabId });
      break;
    }
    case "auto_retry_end": {
      const ev = event as { success?: boolean; finalError?: string };
      if (!ev.success && ev.finalError) {
        deps.send({
          type: "error",
          tabId,
          message: `auto-retry exhausted: ${ev.finalError}`,
        });
      }
      break;
    }
  }
}

// Re-export so dispatcher can drive the subscriber from tests if needed.
export { handleSessionEvent };
