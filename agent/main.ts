/**
 * Aethon agent bridge — JSON-lines over stdio between the Tauri shell and
 * a pi-coding-agent session.
 *
 * Inbound (stdin → bridge):
 *   { "type": "chat", "content": "..." }
 *   { "type": "set_model", "id": "provider/model-id" }
 *   { "type": "stop" }                          // abort the in-flight prompt
 *   { "type": "report" }                        // re-emit current ready state
 *   { "type": "a2ui_event", "event": { ... } }
 *   { "type": "register_component", "componentType": "...", "template": {...} }
 *   { "type": "set_state", "path": "/foo/bar", "value": <any> }
 *   { "type": "set_layout", "payload": {...} }
 *   { "type": "patch_layout", "path": "/components/0/children/2", "value": {...} }
 *   { "type": "register_theme", "theme": { id, label, vars } }
 *   { "type": "mutation_ack", "mutationId": "...", "success": true, "error"?: "..." }
 *   { "type": "frontend_state_patch", "path": "/sidebar/models", "value": <any> }
 *   { "type": "boot_layout", "payload": {...} }
 *   { "type": "tab_open", "tabId": "...", "model"?: "..." , "cwd"?: "..." }
 *   { "type": "tab_close", "tabId": "..." }
 *   { "type": "set_project", "tabId": "...", "cwd": "..." | null }
 *
 * Outbound (bridge → stdout): see issue/repo docs for the full set —
 * this file is now a thin entry point that wires the helpers together.
 *
 * Composition (after the Phase 2 split):
 *
 *   state.ts            — the AethonAgentState data class.
 *   mutation-ack.ts     — Promise/timeout handshake for mutation acks.
 *   notifications.ts    — agent-pushed toasts.
 *   keybindings.ts      — aethon.{register,unregister}Keybinding.
 *   event-routes.ts     — onEvent + extension event-route table.
 *   layout-manager.ts   — setLayout / patchLayout / registerLayout, +
 *                         summarize* runtime helpers.
 *   state-mutation.ts   — extension setState (size guard + per-tab mirror).
 *   extension-loader.ts — discover + load extensions (4 sources) + themes.
 *   aethon-api.ts       — buildAethonApi factory exposed on globalThis.
 *   runtime-snapshot.ts — getRuntimeSnapshot + state-file persistence.
 *   tab-lifecycle.ts    — ensureTab + the pi session subscriber + emitReady.
 *   dispatcher.ts       — the readline loop and 14-case dispatcher.
 *   main.ts (this file) — env wiring + boot order.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  AuthStorage,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

import { logger } from "./logger";
import {
  applyProviderTimeoutOverride,
  runtimeConfigFromEnv,
} from "./runtime-config";
import { resolveStateLimits } from "./state-limits";
import {
  buildSubagentsSection,
  resolveAethonSystemPrompt,
} from "./system-prompt";
import { buildWorkingContextSection } from "./system-prompt/working-context";
import { getWorkingContext } from "./git-context";
import { readSessionTranscript } from "./session-history";
import {
  AethonAgentState,
  type ExtensionFailure,
  type ExtensionFailureSource,
  type LayoutSlotsCatalogue,
} from "./state";
import { buildAethonApi } from "./aethon-api";
import { loadAuthProfiles } from "./auth-profiles";
import {
  getRuntimeSnapshot,
  scheduleStateFileWrite as scheduleStateFileWriteImpl,
} from "./runtime-snapshot";
import { markFrontendReady } from "./mutation-ack";
import { discoverPersistedTabs } from "./extension-loader";
import { loadAllExtensions } from "./boot-sequence";
import { ensureTab, emitReady, tabSessionDir } from "./tab-lifecycle";
import { seedPreparedEnv } from "./devshell";
import { getSubagentsForCwd } from "./subagents";
import { buildExplicitSubagentSteer } from "./subagents/steer";
import { loadDisabledExtensionsSnapshot } from "./disabled-extensions";
import { resolveMemoryContext, readMemoryPath } from "./memory/resolver";
import { renderMemoryPromptSection } from "./memory/renderer";
import { runDispatcher } from "./dispatcher";
import { withWorkerOrigin } from "./origin-gate";
import { buildAethonMcpExtension } from "./mcp";
import { createBootTrace, formatBootSummary } from "./boot-trace";

function rawSend(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  // Boot-phase spans; summarized in the boot log + a `boot_timings` frame
  // once the bridge reaches ready. See boot-trace.ts.
  const bootTrace = createBootTrace();

  // -- Configuration -------------------------------------------------------
  const userDir = process.env.AETHON_USER_DIR ?? join(homedir(), ".aethon");
  const stateFile =
    process.env.AETHON_STATE_FILE ?? join(userDir, "state.json");
  const dbFile = process.env.AETHON_DB_FILE ?? join(userDir, "state", "aethon.sqlite3");
  const projectsDir = process.env.AETHON_PROJECTS_DIR ?? join(userDir, "projects");
  const sessionsDir =
    process.env.AETHON_SESSIONS_DIR ?? join(userDir, "sessions");
  const docsDir = process.env.AETHON_DOCS_DIR;
  const projectRoot = process.env.AETHON_PROJECT_ROOT;
  const releaseMode = process.env.AETHON_RELEASE_MODE === "1";
  const bootLayoutFile = process.env.AETHON_BOOT_LAYOUT_FILE;
  const layoutSlotsFile = process.env.AETHON_LAYOUT_SLOTS_FILE;
  const workerTabId = process.env.AETHON_WORKER_TAB_ID;
  const workerCwd = process.env.AETHON_WORKER_CWD;
  const workerDevshellReady = process.env.AETHON_WORKER_DEVSHELL_READY === "1";
  const workerDevshellKind = process.env.AETHON_WORKER_DEVSHELL_KIND ?? null;
  const workerMode = typeof workerTabId === "string" && workerTabId.length > 0;
  // Per-tab workers stamp registry-replacing messages with their tab id so
  // the frontend can refuse hydrates from background workspaces — see
  // origin-gate.ts. The global bridge sends unstamped (authoritative).
  const send = workerTabId ? withWorkerOrigin(rawSend, workerTabId) : rawSend;
  const { warnKb, hardKb } = resolveStateLimits(
    process.env.AETHON_STATE_WARN_KB,
    process.env.AETHON_STATE_HARD_KB,
  );
  const runtimeConfig = runtimeConfigFromEnv();

  const state = new AethonAgentState({
    userDir,
    stateFile,
    dbFile,
    projectsDir,
    sessionsDir,
    docsDir,
    projectRoot,
    releaseMode,
    bootLayoutFile,
    layoutSlotsFile,
    statePayloadWarnKb: warnKb,
    statePayloadHardKb: hardKb,
    statePayloadWarnBytes: warnKb * 1024,
    statePayloadHardBytes: hardKb * 1024,
    ...runtimeConfig,
  });

  // -- Pi service singletons ----------------------------------------------
  const endServicesInit = bootTrace.span("services-init");
  state.authStorage = AuthStorage.create();
  state.modelRegistry = ModelRegistry.create(state.authStorage);
  state.settingsManager = SettingsManager.create(process.cwd());
  applyProviderTimeoutOverride(state);
  state.authProfiles = loadAuthProfiles(state.userDir);
  endServicesInit();

  // -- User's persisted "disabled extensions" list -----------------------
  // Read before any extension load so the loader honors it on first pass.
  // Hydrate both the name set (used by the loader to skip imports) and
  // the per-entry meta map (used by the frontend to scope project-
  // directory disabled rows to the active project).
  const disabledSnapshot = await bootTrace.measure("disabled-snapshot", () =>
    loadDisabledExtensionsSnapshot(state.userDir),
  );
  for (const name of disabledSnapshot.names) state.disabledExtensions.add(name);
  for (const [name, meta] of disabledSnapshot.meta) {
    state.disabledExtensionMeta.set(name, meta);
  }

  // -- Bundled boot resources read synchronously --------------------------
  const endBootFiles = bootTrace.span("boot-files");
  if (bootLayoutFile) {
    try {
      state.bootLayout = JSON.parse(readFileSync(bootLayoutFile, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger
          .scope("boot")
          .warn(`read ${bootLayoutFile}: ${(err as Error).message}`);
      }
    }
  }
  if (layoutSlotsFile) {
    try {
      state.layoutSlotsCatalogue = JSON.parse(
        readFileSync(layoutSlotsFile, "utf8"),
      ) as LayoutSlotsCatalogue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger
          .scope("slots")
          .warn(`read ${layoutSlotsFile}: ${(err as Error).message}`);
      }
    }
  }

  endBootFiles();

  // -- Side-effect deps shared across modules -----------------------------
  const scheduleStateFileWrite = () => scheduleStateFileWriteImpl(state);
  const apiDeps = {
    send,
    scheduleStateFileWrite,
    getRuntimeSnapshot: () => getRuntimeSnapshot(state),
  };
  const extDeps = { send };

  // -- aethon API -- build BEFORE createAgentSession so pi extensions that
  // touch globalThis.aethon.* see the real API instead of undefined. The
  // same object is the one passed to extension `register(api)` calls — see
  // `AethonExtensionApi` in state.ts for why we don't wrap it. -----
  const aethonApi = buildAethonApi(state, apiDeps);
  (globalThis as { aethon?: typeof aethonApi }).aethon = aethonApi;
  const extensionApi = aethonApi;

  // -- Per-turn working-context injection --------------------------------
  // The appended system prompt is cached at resourceLoader.reload() (pi's
  // ResourceLoader.getAppendSystemPrompt returns a memoized string), so it
  // can't carry per-tab or per-turn-fresh data. The `before_agent_start`
  // hook, by contrast, fires synchronously inside every session.prompt()
  // — which chat.ts wraps in `state.tabContext.run(tabId, …)` — so reading
  // `tabContext.getStore()` here yields the active tab, and its result
  // `systemPrompt` overrides the prompt for that turn only (never
  // persisted). This is how a local model keeps a correct picture of which
  // directory it's working in. See agent/git-context.ts for the git source.
  const softGuardrailPrompt = process.env.AETHON_SOFT_GUARDRAIL_PROMPT;
  state.hardEnforceProjectRootDefault =
    process.env.AETHON_HARD_ENFORCE_PROJECT_ROOT === "1";
  const workingContextExtension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", async (event) => {
      const tabId = state.tabContext.getStore() ?? state.currentAgentTabId;
      const resolvedCwd =
        (tabId ? state.tabProjectCwds.get(tabId) : undefined) ??
        state.currentProjectCwd ??
        process.cwd();
      // getWorkingContext degrades to null internally; .catch is a
      // belt-and-braces guard so a never-expected rejection can't abort
      // the user's turn.
      const git = await getWorkingContext(state, { send }, resolvedCwd).catch(
        () => null,
      );
      const section = buildWorkingContextSection({
        cwd: resolvedCwd,
        git,
        softAnchor: softGuardrailPrompt,
      });
      const memoryContext = await resolveMemoryContext({
        userDir: state.userDir,
        cwd: resolvedCwd,
      }).catch(() => null);
      const memorySection = memoryContext
        ? renderMemoryPromptSection({
            ...memoryContext,
            userMemory: readMemoryPath(memoryContext.user.memoryPath),
            projectMemory: readMemoryPath(memoryContext.project.memoryPath),
          })
        : "";
      let systemPrompt = memorySection
        ? `${event.systemPrompt}\n\n${memorySection}\n\n${section}`
        : `${event.systemPrompt}\n\n${section}`;
      // Advertise the subagents available for THIS tab's cwd, per turn — so a
      // tab on project A never sees project B's subagents even after B opens
      // (the static system-prompt snapshot can't be per-tab).
      const subagents = getSubagentsForCwd(state, resolvedCwd).byName;
      const advert = buildSubagentsSection([...subagents.values()]);
      if (advert) systemPrompt += `\n\n${advert}`;
      // Explicit @name invocation: consume the one-shot steer for this tab
      // (clearing it prevents the subagent's own turn from re-triggering it).
      if (tabId) {
        const explicit = state.pendingExplicitSubagent.get(tabId);
        const names =
          explicit?.names.filter((name) => subagents.has(name)) ?? [];
        if (explicit && names.length > 0) {
          state.pendingExplicitSubagent.delete(tabId);
          systemPrompt += `\n\n${buildExplicitSubagentSteer(names, {
            surface: explicit.surface,
          })}`;
        } else if (explicit) {
          state.pendingExplicitSubagent.delete(tabId);
        }
      }
      return { systemPrompt };
    });
  };

  // -- pi resource loader (system prompt, tools, memory) ------------------
  state.resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: state.settingsManager,
    extensionFactories: [
      buildAethonMcpExtension({
        userDir: state.userDir,
        cwd: workerCwd ?? projectRoot ?? process.cwd(),
      }),
      workingContextExtension,
    ],
    appendSystemPromptOverride: (base) => [
      ...base,
      ...resolveAethonSystemPrompt(getRuntimeSnapshot(state)),
    ],
  });
  // -- Extension loaders + single resource reload --------------------------
  // Orchestration (ordering contract + safe concurrency) lives in
  // boot-sequence.ts. The resource loader reloads ONCE, after every
  // extension source has registered, so the appended system prompt sees
  // them all and sessions bind the instances from that reload. (It used
  // to also reload here, before the loaders — pure duplicate cost: pi
  // re-imports all ~/.pi extensions per reload and nothing between the
  // two reloads read loader state.)
  const loadHooks = {
    onLoaded: (name: string) => {
      state.loadFailures.delete(name);
      scheduleStateFileWrite();
    },
    onProjectLoaded: (name: string, projectRoot: string) => {
      state.projectExtensionRoots.set(name, projectRoot);
      scheduleStateFileWrite();
    },
    onFailure: (
      f: ExtensionFailure & { name: string; source: ExtensionFailureSource },
    ) => {
      state.loadFailures.set(f.name, {
        source: f.source,
        status: f.status,
        error: f.error,
        path: f.path,
        projectRoot: f.projectRoot,
      });
      scheduleStateFileWrite();
    },
  };
  const { startupCwd } = await loadAllExtensions(
    state,
    extDeps,
    extensionApi,
    {
      userDir,
      workerCwd,
      projectRoot,
      trace: bootTrace,
      loadHooks,
      onFrontendEntry: ({ name, entryPath, code }) => {
        state.extensionFrontendModules.set(name, { name, entryPath, code });
      },
    },
  );

  const tabDeps = { send };
  if (!workerMode) {
    // -- Default tab -------------------------------------------------------
    // Resolve the active project's cwd from disk so the default tab's
    // session resume is scoped to the right project on first paint —
    // otherwise a `default` session from a previously-active project
    // leaks into whatever the user opens next (sessions/default/ is
    // shared across project buckets).
    state.tabProjectCwds.set("default", startupCwd);
    // Default-tab creation and persisted-session discovery are
    // independent (tab construction vs. read-only session-dir metadata
    // scan), so overlap them. Both must complete before emitReady: the
    // ready payload carries the default tab's model/thinking level AND
    // the discoveredTabs list.
    const [, discovered] = await Promise.all([
      bootTrace.measure("ensure-default-tab", () =>
        ensureTab(state, tabDeps, "default", { trace: bootTrace }),
      ),
      bootTrace.measure("discover-tabs", () => discoverPersistedTabs(state)),
    ]);
    state.discoveredTabs = discovered;

    scheduleStateFileWrite();
    emitReady(state, tabDeps);
    logger.scope("boot").info(formatBootSummary(bootTrace));
    send({
      type: "boot_timings",
      total: bootTrace.totalMs(),
      spans: bootTrace.summary(),
    });

    // Replay the default tab's persisted pi session history so all tabs use
    // the same session_history IPC path. Scope the read by the SAME cwd
    // `ensureTab` resolved against — when no project is active, both fall
    // back to the startup cwd. Passing `undefined` here would let the
    // replay surface the latest JSONL from any cwd while `ensureTab` (which
    // filters via `findSessionFileMatchingCwd`) created an empty session,
    // leaving the UI showing a leaked transcript that the agent cannot
    // continue.
    readSessionTranscript(tabSessionDir(state, "default"), startupCwd)
      .then((messages) => {
        if (messages.length > 0) {
          send({ type: "session_history", tabId: "default", messages });
        }
      })
      .catch((err: unknown) => {
        logger
          .scope("session")
          .warn(`default tab history replay failed: ${(err as Error).message}`);
      });
  } else {
    state.tabProjectCwds.set(workerTabId, startupCwd);
    if (workerDevshellReady) {
      seedPreparedEnv(startupCwd, process.env, workerDevshellKind);
    }
    markFrontendReady(state);
    scheduleStateFileWrite();
    send({ type: "worker_ready", tabId: workerTabId, cwd: startupCwd });
    logger.scope("boot").info(formatBootSummary(bootTrace));
    send({
      type: "boot_timings",
      tabId: workerTabId,
      total: bootTrace.totalMs(),
      spans: bootTrace.summary(),
    });
  }

  // -- Run the dispatcher ------------------------------------------------
  const dispatcherDeps = {
    send,
    scheduleStateFileWrite,
    loadHooks,
  };
  await runDispatcher(state, dispatcherDeps, aethonApi, extensionApi);
}

main().catch((err: unknown) => {
  rawSend({
    type: "error",
    message: `fatal: ${(err as Error)?.message ?? String(err)}`,
  });
  process.exit(1);
});

// Suppress unused-import warnings for re-export-only types.
export type _SessionManagerRef = typeof SessionManager;
