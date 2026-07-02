/**
 * Startup extension-load orchestration, extracted from `main()` so the
 * ordering contract is testable and the safe concurrency lives in one
 * place. Runs identically for the global bridge and per-tab workers.
 *
 * ORDERING CONTRACT — do not re-order casually:
 *
 *  1. `loadAethonExtensions` → `loadAethonExtensionPackages` stay
 *     strictly SERIAL: their `register()` calls share the process-global
 *     `currentExtensionLoadScope`/`currentExtensionName` stack, and
 *     registry later-wins order across sources is semantic.
 *  2. Loose-file themes and pi-extension discovery are independent of
 *     each other (different registries) and run CONCURRENTLY — but both
 *     must FOLLOW the register-loaders: a loose theme file overrides a
 *     `register()`-supplied theme of the same id (later-wins), and
 *     pi-discovery's `registry.has()` precedence rule must see every
 *     loader-registered name first.
 *  3. `captureProjectExtensionBaseline` sits exactly between the
 *     non-project loads above and the project load below — project
 *     switches restore registries from this snapshot.
 *  4. Project extensions land on top of the baseline.
 *  5. ONE `resourceLoader.reload()` finishes the sequence: pi imports
 *     its extensions and builds the system prompt with
 *     `appendSystemPromptOverride` seeing every loaded extension.
 *     Sessions bind the extension instances from this reload, so it
 *     must be the last step before any `ensureTab`.
 *
 * The active-project cwd read (a pure file/sqlite read) starts
 * immediately and resolves concurrently with steps 1–3; its value is
 * only needed at step 4.
 */

import {
  loadAethonExtensions,
  loadAethonExtensionPackages,
  loadAethonThemeDirectory,
  loadProjectAethonExtensions,
  discoverPiAethonExtensions,
} from "./extension-loader";
import type { ExtensionLoaderDeps, LoadHooks } from "./extension-loader/shared";
import { captureProjectExtensionBaseline } from "./projectLifecycle";
import { readActiveProjectCwd, resolveStartupCwd } from "./active-project-cwd";
import type { AethonAgentState, AethonExtensionApi } from "./state";
import type { BootTrace } from "./boot-trace";

export interface LoadAllExtensionsOptions {
  userDir: string;
  /** Set for per-tab workers: skips the active-project read entirely. */
  workerCwd?: string;
  projectRoot?: string;
  trace?: BootTrace;
  loadHooks: LoadHooks;
  onFrontendEntry: (entry: {
    name: string;
    entryPath: string;
    code: string;
  }) => void;
}

export async function loadAllExtensions(
  state: AethonAgentState,
  extDeps: ExtensionLoaderDeps,
  api: AethonExtensionApi,
  options: LoadAllExtensionsOptions,
): Promise<{ startupCwd: string }> {
  const { trace } = options;
  const measure = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    trace ? trace.measure(name, fn) : fn();

  const activeProjectCwdPromise =
    options.workerCwd !== undefined
      ? null
      : measure("active-project-cwd", () =>
          readActiveProjectCwd(options.userDir),
        );

  await measure("user-extensions", () =>
    loadAethonExtensions(
      state,
      extDeps,
      api,
      state.loadedExtensions,
      options.loadHooks,
    ),
  );
  await measure("extension-packages", () =>
    loadAethonExtensionPackages(state, extDeps, api, state.loadedExtensions, {
      onFrontendEntry: options.onFrontendEntry,
      onLoaded: options.loadHooks.onLoaded,
      onFailure: options.loadHooks.onFailure,
    }),
  );

  await Promise.all([
    measure("themes", () =>
      loadAethonThemeDirectory(state, {
        registerTheme: (theme) => api.registerTheme(theme),
      }),
    ),
    measure("pi-discovery", () =>
      discoverPiAethonExtensions(state.loadedExtensions),
    ),
  ]);

  captureProjectExtensionBaseline(state);

  const activeProjectCwd =
    options.workerCwd ?? (await activeProjectCwdPromise) ?? undefined;
  const startupCwd = resolveStartupCwd(
    activeProjectCwd,
    options.projectRoot,
    options.userDir,
    process.cwd(),
  );

  await measure("project-extensions", () =>
    loadProjectAethonExtensions(
      state,
      extDeps,
      startupCwd,
      api,
      state.loadedExtensions,
      state.loadedProjectExtensionFiles,
      state.failedProjectExtensionFiles,
      options.loadHooks,
    ),
  );
  state.currentProjectCwd = startupCwd;

  await measure("resource-reload", () => state.resourceLoader.reload());

  return { startupCwd };
}
