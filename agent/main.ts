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
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

import { logger } from "./logger";
import { resolveStateLimits } from "./state-limits";
import { resolveAethonSystemPrompt } from "./system-prompt";
import { readSessionTranscript } from "./session-history";
import {
  AethonAgentState,
  type ExtensionFailure,
  type ExtensionFailureSource,
  type LayoutSlotsCatalogue,
} from "./state";
import { buildAethonApi } from "./aethon-api";
import {
  getRuntimeSnapshot,
  scheduleStateFileWrite as scheduleStateFileWriteImpl,
} from "./runtime-snapshot";
import {
  loadAethonExtensions,
  loadAethonExtensionPackages,
  loadAethonThemeDirectory,
  loadProjectAethonExtensions,
  discoverPersistedTabs,
  discoverPiAethonExtensions,
} from "./extension-loader";
import {
  ensureTab,
  emitReady,
  tabSessionDir,
} from "./tab-lifecycle";
import { loadDisabledExtensions } from "./disabled-extensions";
import {
  captureProjectExtensionBaseline,
  runDispatcher,
} from "./dispatcher";
import { discoverPiSkills } from "./pi-skills";

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Read the active project's cwd from `<userDir>/projects.json`.
 *
 * The frontend's `useProjectOps` boot effect sends `set_project` shortly
 * after the bridge is ready, but that arrives over the dispatcher loop —
 * which races the synchronous boot replay below. Reading projects.json
 * directly lets the bridge scope the default tab's `ensureTab` and
 * session replay to the right cwd on its very first paint, instead of
 * picking the most-recently-touched session in `sessions/default/`
 * regardless of which project produced it.
 *
 * Returns `undefined` if the file is missing, malformed, or has no
 * active project; the caller falls back to project-agnostic behaviour.
 */
async function readActiveProjectCwd(userDir: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(join(userDir, "projects.json")).text();
    const parsed = JSON.parse(text) as {
      activeId?: unknown;
      projects?: { id?: unknown; path?: unknown }[];
    };
    if (typeof parsed.activeId !== "string" || !parsed.activeId) return undefined;
    if (!Array.isArray(parsed.projects)) return undefined;
    const active = parsed.projects.find(
      (p) => p && typeof p.id === "string" && p.id === parsed.activeId,
    );
    return active && typeof active.path === "string" && active.path.length > 0
      ? active.path
      : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // -- Configuration -------------------------------------------------------
  const userDir = process.env.AETHON_USER_DIR ?? join(homedir(), ".aethon");
  const stateFile =
    process.env.AETHON_STATE_FILE ?? join(userDir, "state.json");
  const sessionsDir =
    process.env.AETHON_SESSIONS_DIR ?? join(userDir, "sessions");
  const docsDir = process.env.AETHON_DOCS_DIR;
  const projectRoot = process.env.AETHON_PROJECT_ROOT;
  const releaseMode = process.env.AETHON_RELEASE_MODE === "1";
  const bootLayoutFile = process.env.AETHON_BOOT_LAYOUT_FILE;
  const layoutSlotsFile = process.env.AETHON_LAYOUT_SLOTS_FILE;
  const { warnKb, hardKb } = resolveStateLimits(
    process.env.AETHON_STATE_WARN_KB,
    process.env.AETHON_STATE_HARD_KB,
  );

  const state = new AethonAgentState({
    userDir,
    stateFile,
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
  });

  // -- Pi service singletons ----------------------------------------------
  state.authStorage = AuthStorage.create();
  state.modelRegistry = ModelRegistry.create(state.authStorage);
  state.settingsManager = SettingsManager.create(process.cwd());

  // -- User's persisted "disabled extensions" list -----------------------
  // Read before any extension load so the loader honors it on first pass.
  const disabled = await loadDisabledExtensions(state.userDir);
  for (const name of disabled) state.disabledExtensions.add(name);

  // -- Bundled boot resources read synchronously --------------------------
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

  // -- pi resource loader (system prompt, tools, memory) ------------------
  state.resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: state.settingsManager,
    appendSystemPromptOverride: (base) => [
      ...base,
      ...resolveAethonSystemPrompt(getRuntimeSnapshot(state)),
    ],
  });
  state.piSkills = await discoverPiSkills();
  await state.resourceLoader.reload();

  // -- Extension loaders --------------------------------------------------
  const loadHooks = {
    onLoaded: (name: string) => {
      state.loadFailures.delete(name);
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
      });
      scheduleStateFileWrite();
    },
  };
  await loadAethonExtensions(
    state,
    extDeps,
    extensionApi,
    state.loadedExtensions,
    loadHooks,
  );
  await loadAethonExtensionPackages(
    state,
    extDeps,
    extensionApi,
    state.loadedExtensions,
    {
      onFrontendEntry: ({ name, entryPath, code }) => {
        state.extensionFrontendModules.set(name, { name, entryPath, code });
      },
      onLoaded: loadHooks.onLoaded,
      onFailure: loadHooks.onFailure,
    },
  );
  await loadAethonThemeDirectory(state, {
    registerTheme: (theme) => aethonApi.registerTheme(theme),
  });
  await discoverPiAethonExtensions(state.loadedExtensions);

  // -- Project-extension baseline ----------------------------------------
  // Snapshot the post-non-project-load state. Anything project-directory
  // extensions register lands ON TOP of this baseline; switching projects
  // restores the registries from this snapshot.
  captureProjectExtensionBaseline(state);

  await loadProjectAethonExtensions(
    state,
    extDeps,
    process.cwd(),
    extensionApi,
    state.loadedExtensions,
    state.loadedProjectExtensionFiles,
    state.failedProjectExtensionFiles,
    loadHooks,
  );
  state.currentProjectCwd = process.cwd();

  // Reload so the appendSystemPromptOverride sees the populated extensions.
  await state.resourceLoader.reload();

  // -- Default tab -------------------------------------------------------
  // Resolve the active project's cwd from disk so the default tab's
  // session resume is scoped to the right project on first paint —
  // otherwise a `default` session from a previously-active project
  // leaks into whatever the user opens next (sessions/default/ is
  // shared across project buckets).
  const activeProjectCwd = await readActiveProjectCwd(userDir);
  if (activeProjectCwd) {
    state.tabProjectCwds.set("default", activeProjectCwd);
  }
  const tabDeps = { send };
  await ensureTab(state, tabDeps, "default");

  // -- Discover persisted sessions for the "Recent sessions" empty-state -
  state.discoveredTabs = await discoverPersistedTabs(state);

  scheduleStateFileWrite();
  emitReady(state, tabDeps);

  // Replay the default tab's persisted pi session history so all tabs use
  // the same session_history IPC path. Scope the read by the SAME cwd
  // `ensureTab` resolved against — when no project is active, both fall
  // back to `process.cwd()`. Passing `undefined` here would let the
  // replay surface the latest JSONL from any cwd while `ensureTab` (which
  // filters via `findSessionFileMatchingCwd`) created an empty session,
  // leaving the UI showing a leaked transcript that the agent cannot
  // continue.
  const defaultTabReplayCwd = activeProjectCwd ?? process.cwd();
  readSessionTranscript(tabSessionDir(state, "default"), defaultTabReplayCwd)
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

  // -- Run the dispatcher ------------------------------------------------
  const dispatcherDeps = {
    send,
    scheduleStateFileWrite,
    loadHooks,
  };
  await runDispatcher(state, dispatcherDeps, aethonApi, extensionApi);
}

main().catch((err: unknown) => {
  send({
    type: "error",
    message: `fatal: ${(err as Error)?.message ?? String(err)}`,
  });
  process.exit(1);
});

// Suppress unused-import warnings for re-export-only types.
export type _SessionManagerRef = typeof SessionManager;
