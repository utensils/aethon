/**
 * Per-tab session creation. `ensureTab` is the one entry point: callers
 * pass a tabId and (optionally) an initial model + cwd override; we
 * either return the existing record or build a fresh pi `AgentSession`
 * scoped to the tab's cwd. The per-tab subscriber is wired in here so
 * `handleSessionEvent` (in `./events.ts`) carries the routing context.
 *
 * Sessions share authStorage / modelRegistry / settingsManager /
 * resourceLoader so they all see the same models and extension surface
 * — only message history and active turn are isolated.
 */

import { mkdirSync } from "node:fs";
import {
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { buildShellTools } from "../shell-tools";
import { buildDashboardTools } from "../dashboard-tools";
import { buildDevshellSpawnHook, ensureFetched as ensureDevshellFetched } from "../devshell";
import { wrapWithSourceGuard } from "../source-guard";
import { logger } from "../logger";
import { findSessionFileMatchingCwd } from "../session-history";
import type { AethonAgentState, TabRecord } from "../state";
import { handleSessionEvent } from "./events";
import {
  buildPickerModels,
  ensurePickerHasModel,
} from "./models";
import { refreshPiSlashCommands } from "./slash-commands";
import { modelDescriptor, modelKey, tabSessionDir } from "./utils";
import type { TabLifecycleDeps } from "./utils";

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

  // Warm the devshell cache for this tab's cwd in the background.
  // The fetch races with the first bash tool call; if the resolver
  // hasn't completed in time, the spawnHook emits a one-shot
  // advisory warning and the command runs against the host env.
  // Subsequent commands pick up the devshell env automatically.
  void ensureDevshellFetched(state, deps, resolvedCwd);

  // Shadow pi's built-in `bash` tool with our own that mounts the
  // devshell spawnHook. The customTools registry merges later-wins
  // by name (see pi-coding-agent agent-session.js:1834), so a
  // `customTools` entry with `name === "bash"` overrides the
  // baseline built-in. The hook receives pi's BashSpawnContext and
  // mutates `env` to layer the project's Nix devshell over the host
  // env — same source of truth as the Rust PTY intercept.
  const devshellBashTool = createBashToolDefinition(resolvedCwd, {
    spawnHook: buildDevshellSpawnHook(state, deps),
  });

  const { session } = await createAgentSession({
    authStorage: state.authStorage,
    modelRegistry: state.modelRegistry,
    settingsManager: state.settingsManager,
    sessionManager,
    resourceLoader: state.resourceLoader,
    customTools: [
      devshellBashTool,
      ...buildShellTools(),
      ...buildDashboardTools(),
    ],
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
