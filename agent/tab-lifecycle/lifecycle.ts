/**
 * Per-tab session creation. `ensureTab` is the one entry point: callers
 * pass a tabId and (optionally) an initial model + cwd override; we
 * either return the existing record or build a fresh pi `AgentSession`
 * scoped to the tab's cwd. The per-tab subscriber is wired in here so
 * `handleSessionEvent` (in `./events.ts`) carries the routing context.
 *
 * Sessions usually share authStorage / modelRegistry / settingsManager /
 * resourceLoader. Tabs with an auth profile get isolated auth/model services
 * so one desktop session can switch between multiple signed-in accounts.
 */

import { mkdirSync } from "node:fs";
import {
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { buildShellTools } from "../shell-tools";
import { buildA2uiTools } from "../a2ui-tools";
import { createAethonBashToolDefinition } from "../bash-tool";
import { buildDashboardTools } from "../dashboard-tools";
import { buildEditorTools } from "../editor-tools";
import { buildSessionTitleTools } from "../session-title-tool";
import { buildSchedulerTools } from "../scheduler-tools";
import {
  buildSubagentTaskBatchTool,
  buildSubagentTaskTool,
} from "../subagents/task-tool";
import { buildMemoryTools } from "../memory/tools";
import {
  installCodexFastModePayloadHook,
  supportsCodexFastMode,
} from "../codex-fast-mode";
import {
  buildDevshellSpawnHook,
  ensurePrepared as ensureDevshellPrepared,
} from "../devshell";
import { wrapWithSourceGuard } from "../source-guard";
import { logger } from "../logger";
import { authProfileServicesForTab } from "../auth-profiles";
import { findSessionFileMatchingCwd } from "../session-history";
import type { AethonAgentState, TabRecord } from "../state";
import { contextUsageSnapshot, emitContextUsage } from "../context-usage";
import { handleSessionEvent } from "./events";
import { installAethonRetryClassifier } from "./retry";
import { buildPickerModels, ensurePickerHasModel } from "./models";
import { refreshPiSlashCommands } from "./slash-commands";
import { modelDescriptor, modelKey, tabSessionDir } from "./utils";
import type { TabLifecycleDeps } from "./utils";

export interface EnsureTabOptions {
  initialModel?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  cwdOverride?: string;
}

const lifecycleLog = logger.scope("tab-lifecycle");
const WORKER_MODE =
  typeof process.env.AETHON_WORKER_TAB_ID === "string" &&
  process.env.AETHON_WORKER_TAB_ID.length > 0;

/** Cwd-precedence policy for a tab's session, exported so the multi-tab
 *  scoping rules have direct regression coverage:
 *
 *    1. `cwdOverride` (carried on `tab_open` — the frontend's intent),
 *    2. the tab's previously-recorded cwd (`tabProjectCwds`),
 *    3. the bridge's active-project cwd,
 *    4. the user dir, then `process.cwd()`.
 *
 *  (1) and (2) outranking (3) is what keeps a `tab_open` that arrives
 *  before `set_project` — or a tab in a background workspace — from
 *  adopting another project's cwd. */
export function resolveTabCwd(
  tabId: string,
  options: Pick<EnsureTabOptions, "cwdOverride">,
  state: Pick<
    AethonAgentState,
    "tabProjectCwds" | "currentProjectCwd" | "userDir"
  >,
): string {
  return (
    options.cwdOverride ??
    state.tabProjectCwds.get(tabId) ??
    state.currentProjectCwd ??
    state.userDir ??
    process.cwd()
  );
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

  const resolvedCwd = resolveTabCwd(tabId, options, state);
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

  // Frontend tab creation normally prepares the devshell before `tab_open`.
  // Tab workers are spawned by Rust only after that prepare step has run and
  // after any ready env has been injected into process.env, so do not issue a
  // second blocking devshell_query here. That duplicate query can wedge the
  // first prompt before pi emits agent_start if the frontend ack path is not
  // available yet.
  if (WORKER_MODE) {
    lifecycleLog.info(
      `worker session using pre-spawn devshell cwd=${resolvedCwd} tabId=${tabId}`,
    );
  } else {
    // Never let devshell preparation abort tab creation — a session on the
    // host env beats no session. ensurePrepared also self-skips before the
    // frontend handshake (startup default tab), where the query can't be
    // answered and would otherwise wedge the bridge until a fatal timeout.
    await ensureDevshellPrepared(state, deps, resolvedCwd).catch(
      (err: unknown) => {
        lifecycleLog.warn(
          `devshell prepare failed for ${resolvedCwd}: ${(err as Error).message}; continuing with host env`,
        );
      },
    );
  }

  // Shadow pi's built-in `bash` tool with our own that mounts the
  // devshell spawnHook. The customTools registry merges later-wins
  // by name (see pi-coding-agent agent-session.js:1834), so a
  // `customTools` entry with `name === "bash"` overrides the
  // baseline built-in. The hook receives pi's BashSpawnContext and
  // mutates `env` to layer the project's Nix devshell over the host
  // env — same source of truth as the Rust PTY intercept.
  const devshellBashTool = createAethonBashToolDefinition(state, resolvedCwd, {
    spawnHook: buildDevshellSpawnHook(state, deps),
  });
  const authServices = authProfileServicesForTab(
    state,
    tabId,
    options.initialModel,
  );

  const { session } = await createAgentSession({
    authStorage: authServices.authStorage,
    modelRegistry: authServices.modelRegistry,
    settingsManager: state.settingsManager,
    sessionManager,
    resourceLoader: state.resourceLoader,
    customTools: [
      devshellBashTool,
      ...buildSessionTitleTools(state, deps, tabId),
      ...buildA2uiTools(),
      ...buildShellTools(),
      ...buildDashboardTools(),
      ...buildEditorTools(),
      ...buildMemoryTools(state, tabId),
      ...buildSchedulerTools(state, deps, tabId),
      buildSubagentTaskTool(state, deps, tabId),
      buildSubagentTaskBatchTool(state, deps, tabId),
    ],
    ...(options.initialModel ? { model: options.initialModel } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  });
  lifecycleLog.info(`session ready tabId=${tabId} cwd=${resolvedCwd}`);
  installAethonRetryClassifier(session);
  installCodexFastModePayloadHook(state, session);
  wrapWithSourceGuard(session.agent, state.projectRoot, {
    tabRoot: resolvedCwd,
    hardEnforce: () =>
      state.tabHardEnforce.get(tabId) ?? state.hardEnforceProjectRootDefault,
    planMode: () => state.tabPlanMode.get(tabId) === true,
  });

  const rec: TabRecord = {
    id: tabId,
    session,
    toolArgsCache: new Map(),
    promptInFlight: false,
    agentEndFired: false,
    queuedCount: 0,
    toolCardSeq: 0,
    responseMessageSeq: 0,
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
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
    codexFastMode: state.codexFastMode,
    codexFastModeSupported: supportsCodexFastMode(session.model),
    contextUsage: contextUsageSnapshot(state, tabId, rec),
  });
  emitContextUsage(state, deps, tabId, rec);

  return rec;
}
