/**
 * In-process extension hot toggle.
 *
 * Toggling an extension used to emit `reload_required` — a full bridge
 * kill-and-respawn (session re-creation, MCP reconnect, resource
 * reloads) because the disabled list was only consulted at cold boot.
 * This module applies the toggle IN process instead: run every
 * registered teardown, clear the (wholly extension-owned) registries,
 * and re-run the exact boot load path (`loadAllExtensions`, which also
 * re-captures the project baseline and does the single
 * `resourceLoader.reload()`), now honoring the updated disabled set.
 *
 * From an extension's point of view this is indistinguishable from the
 * respawn it replaced — full unload + fresh register() — so the
 * teardown contract, ordering semantics, and later-wins precedence are
 * preserved by construction rather than by per-key bookkeeping. What it
 * does NOT touch: pi sessions (aethon extensions register no pi tools),
 * MCP servers, in-flight prompts, or the process itself.
 *
 * Deliberately refused (falls back to the reload_required respawn):
 *  - pi-extension rows: those are loaded by pi's resource loader and
 *    bound into live sessions — a respawn is the only clean boundary.
 *  - worker bridges: they don't own the frontend surface. (The Rust
 *    router already sends set_extension_disabled to the global bridge
 *    only; the guard is belt-and-braces.)
 *  - concurrent toggles: a second toggle while a reload is in flight
 *    would interleave registry writes.
 *  - kill-switch: AETHON_HOT_EXTENSION_TOGGLE=0 forces the respawn
 *    path everywhere.
 */

import { loadAllExtensions } from "./boot-sequence";
import type { LoadHooks } from "./extension-loader/shared";
import { emitExtensionRegistrySnapshot } from "./projectLifecycle";
import { emitGlobalReady } from "./dispatcherTypes";
import { logger } from "./logger";
import type {
  AethonAgentState,
  AethonExtensionApi,
  ExtensionSource,
} from "./state";

const log = logger.scope("hot-toggle");

let hotReloadInFlight = false;

export interface HotToggleDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
  loadHooks: LoadHooks;
}

export function canHotToggle(
  state: AethonAgentState,
  source: ExtensionSource,
): { ok: true } | { ok: false; reason: string } {
  if (process.env.AETHON_HOT_EXTENSION_TOGGLE === "0") {
    return { ok: false, reason: "disabled via AETHON_HOT_EXTENSION_TOGGLE=0" };
  }
  if (source === "pi-extension") {
    return { ok: false, reason: "pi extensions are bound into live sessions" };
  }
  if (typeof process.env.AETHON_WORKER_TAB_ID === "string") {
    return { ok: false, reason: "worker bridges do not own the UI surface" };
  }
  if (hotReloadInFlight) {
    return { ok: false, reason: "another hot reload is in flight" };
  }
  return { ok: true };
}

/** Run every registered teardown (same guarded pattern as the
 *  project-switch unload) and clear every extension-owned registry back
 *  to its boot-empty state, ready for a fresh load pass. */
function resetExtensionSurface(state: AethonAgentState): void {
  for (const teardowns of [
    state.projectExtensionTeardowns,
    state.userExtensionTeardowns,
  ]) {
    for (const fn of teardowns) {
      try {
        const result = fn();
        if (
          result &&
          typeof (result as Promise<unknown>).catch === "function"
        ) {
          (result as Promise<unknown>).catch((err: unknown) => {
            log.warn(`teardown async error: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        log.warn(`teardown sync error: ${(err as Error).message}`);
      }
    }
    teardowns.length = 0;
  }

  state.loadedExtensions.clear();
  state.projectExtensionRoots.clear();
  state.loadFailures.clear();
  state.loadedProjectExtensionFiles.clear();
  state.failedProjectExtensionFiles.clear();

  state.extensionComponents.clear();
  state.extensionThemes.clear();
  state.extensionSlashCommands.clear();
  state.extensionKeybindings.clear();
  state.extensionMenuItems.clear();
  state.extensionLayouts.clear();
  state.extensionEventRoutes.clear();
  state.eventRoutingMode = "builtin";
  state.a2uiEventHandlers.length = 0;
  state.registeredHandlerKeys.clear();
  state.currentExtensionHandlerOrdinals.clear();
  state.extensionStateTree = {};
  state.extensionStateKeys.clear();
  state.extensionFrontendModules.clear();
  state.extensionHighlightGrammars.clear();
  state.extensionLayout = undefined;
  state.pendingLayoutPatches = [];
  state.extPathOwners.clear();
  // Notified-runtime-error suppression must reset with the surface: a
  // re-registered extension whose error recurs should re-notify.
  state.notifiedExtRuntimeErrors.clear();
  state.projectBaseline = null;
}

/** Apply a toggle in process: teardown + registry reset + the exact
 *  boot load path with the updated disabled set + wholesale re-emit.
 *  Returns "applied" on success; "fallback" means the caller should
 *  take the old reload_required respawn path (the reset alone leaves
 *  state no worse than the respawn's kill would). */
export async function hotReloadExtensions(
  state: AethonAgentState,
  deps: HotToggleDeps,
  api: AethonExtensionApi,
): Promise<"applied" | "fallback"> {
  hotReloadInFlight = true;
  const started = performance.now();
  try {
    resetExtensionSurface(state);
    await loadAllExtensions(state, { send: deps.send }, api, {
      userDir: state.userDir,
      // Pin the load to the LIVE project cwd (a set_project may have
      // moved it since boot) instead of re-reading projects.json.
      workerCwd: state.currentProjectCwd ?? undefined,
      projectRoot: state.projectRoot,
      loadHooks: deps.loadHooks,
      onFrontendEntry: ({ name, entryPath, code }) => {
        state.extensionFrontendModules.set(name, { name, entryPath, code });
      },
    });
    emitExtensionRegistrySnapshot(state, deps);
    await emitGlobalReady(state, deps);
    deps.scheduleStateFileWrite();
    log.info(
      `hot toggle applied in ${Math.round(performance.now() - started)}ms`,
    );
    return "applied";
  } catch (err) {
    log.warn(
      `hot toggle failed (${(err as Error).message}); falling back to respawn`,
    );
    return "fallback";
  } finally {
    hotReloadInFlight = false;
  }
}

/** Test-only: reset the in-flight latch. */
export function resetHotToggleForTest(): void {
  hotReloadInFlight = false;
}
