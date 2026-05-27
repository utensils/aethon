/**
 * Directory-based extension loading: the generic per-directory loader,
 * plus the user-dir and project-dir wrappers.
 *
 *  - `loadAethonExtensionDirectory` is the workhorse — parallel-import
 *    + sequential register() with disabled-list + lifecycle events.
 *  - `loadAethonExtensions` wraps it for `~/.aethon/extensions/`.
 *  - `loadProjectAethonExtensions` walks the project's
 *    `.aethon/extensions/` directories via `findProjectExtensionDirs`
 *    and binds the per-project `displayName` so the sidebar groups
 *    rows under their project bucket.
 *
 * The `state.currentExtensionLoadScope` / `currentExtensionName`
 * registers-on-stack pair is the contract `onUnload()` callbacks
 * (set inside `register(api)`) rely on to scope teardown buckets.
 * Do not move that mechanism out of this module — moving it across
 * file boundaries would let a stale scope leak across registrations.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { findProjectExtensionDirs } from "../project-extensions";
import { logger } from "../logger";
import type {
  AethonAgentState,
  AethonExtensionApi,
  AethonExtensionModule,
  ExtensionSource,
} from "../state";
import type { ExtensionLoaderDeps, LoadHooks } from "./shared";

export function projectExtensionDisplayName(
  projectRoot: string,
  extensionDir: string,
  fileName: string,
): string {
  const extensionBase = fileName.replace(/\.(ts|js|mjs)$/, "");
  const scopeDir = dirname(dirname(extensionDir));
  const rootName = basename(projectRoot) || "project";
  const scope = relative(projectRoot, scopeDir).replace(/\\/g, "/");
  return scope && !scope.startsWith("..")
    ? `${rootName}/${scope}:${extensionBase}`
    : `${rootName}:${extensionBase}`;
}

interface LoadDirectoryOptions {
  dir: string;
  source: Extract<ExtensionSource, "directory" | "project-directory">;
  logPrefix: string;
  displayName?: (fileName: string) => string;
  loadedFiles?: Set<string>;
  /** Files we previously tried to import that errored. Skipped on retry
   *  to keep the warn-loop quiet; the failure is already in
   *  `state.loadFailures` and surfaced via `extension_lifecycle`. */
  failedFiles?: Set<string>;
  onLoaded?: (name: string) => void;
  onProjectLoaded?: (name: string, projectRoot: string) => void;
  onFailure?: (failure: {
    name: string;
    source: Extract<ExtensionSource, "directory" | "project-directory">;
    status: "failed" | "skipped";
    error: string;
    path: string;
    projectRoot?: string;
  }) => void;
}

export async function loadAethonExtensionDirectory(
  state: AethonAgentState,
  deps: ExtensionLoaderDeps,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  options: LoadDirectoryOptions,
): Promise<void> {
  const log = logger.scope(options.logPrefix);
  let entries: string[];
  try {
    entries = await readdir(options.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`readdir ${options.dir}: ${(err as Error).message}`);
    }
    return;
  }
  // Parallelize import; keep register() sequential so registrations against
  // shared maps (handler dedupe, theme/component registries) stay
  // deterministic.
  const allCandidates = entries
    .filter((name) => /\.(ts|js|mjs)$/.test(name))
    .map((name) => ({
      name,
      file: join(options.dir, name),
      displayName:
        options.displayName?.(name) ?? name.replace(/\.(ts|js|mjs)$/, ""),
    }))
    .filter(
      (c) =>
        !options.loadedFiles?.has(c.file) &&
        !options.failedFiles?.has(c.file),
    );

  // Honor the user's "disabled" list: emit a `disabled` lifecycle event
  // (so the sidebar can surface the row + the failure registry knows
  // the extension is intentionally not loaded) and skip the import.
  // Don't add to failedFiles — the user can re-enable, at which point
  // we want a fresh load attempt.
  const candidates: typeof allCandidates = [];
  for (const c of allCandidates) {
    if (state.disabledExtensions.has(c.displayName)) {
      log.info(`${c.name}: disabled by user, skipping`);
      deps.send({
        type: "extension_lifecycle",
        name: c.displayName,
        source: options.source,
        status: "disabled",
        path: c.file,
      });
      continue;
    }
    candidates.push(c);
  }

  const imports = await Promise.allSettled(
    candidates.map(
      (c) =>
        import(pathToFileURL(c.file).href) as Promise<AethonExtensionModule>,
    ),
  );

  for (let i = 0; i < candidates.length; i++) {
    const { name, file, displayName } = candidates[i];
    const result = imports[i];
    try {
      if (result.status === "rejected") {
        throw result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));
      }
      const mod = result.value;
      const register = mod.register ?? mod.default?.register;
      if (typeof register !== "function") {
        log.warn(`${name}: no register() export, skipping`);
        options.failedFiles?.add(file);
        deps.send({
          type: "extension_lifecycle",
          name: displayName,
          source: options.source,
          status: "skipped",
          error: "no register() export",
          path: file,
        });
        options.onFailure?.({
          name: displayName,
          source: options.source,
          status: "skipped",
          error: "no register() export",
          path: file,
        });
        continue;
      }
      // Track which extension's register() is on the stack so onUnload()
      // calls bind to the right teardown bucket. Project-directory
      // teardowns fire on project switch; user-level teardowns persist.
      const prevScope = state.currentExtensionLoadScope;
      const prevExtName = state.currentExtensionName;
      state.currentExtensionLoadScope =
        options.source === "project-directory" ? "project" : "user";
      state.currentExtensionName = displayName;
      try {
        await register(api);
      } finally {
        state.currentExtensionLoadScope = prevScope;
        state.currentExtensionName = prevExtName;
      }
      registry.set(displayName, options.source);
      options.loadedFiles?.add(file);
      options.onLoaded?.(displayName);
      log.info(`loaded ${displayName} from ${name}`);
      deps.send({
        type: "extension_lifecycle",
        name: displayName,
        source: options.source,
        status: "loaded",
        path: file,
      });
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`${name}: ${message}`);
      options.failedFiles?.add(file);
      deps.send({
        type: "extension_lifecycle",
        name: displayName,
        source: options.source,
        status: "failed",
        error: message,
        path: file,
      });
      options.onFailure?.({
        name: displayName,
        source: options.source,
        status: "failed",
        error: message,
        path: file,
      });
    }
  }
}

export async function loadAethonExtensions(
  state: AethonAgentState,
  deps: ExtensionLoaderDeps,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  hooks?: LoadHooks,
): Promise<void> {
  await loadAethonExtensionDirectory(state, deps, api, registry, {
    dir: join(state.userDir, "extensions"),
    source: "directory",
    logPrefix: "aethon-ext",
    onLoaded: hooks?.onLoaded,
    onProjectLoaded: hooks?.onProjectLoaded,
    onFailure: hooks?.onFailure,
  });
}

export async function loadProjectAethonExtensions(
  state: AethonAgentState,
  deps: ExtensionLoaderDeps,
  cwd: string,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  loadedFiles: Set<string>,
  failedFiles: Set<string>,
  hooks?: LoadHooks,
): Promise<{ loaded: number; failed: number }> {
  const dirs = await findProjectExtensionDirs(cwd);
  const before = loadedFiles.size;
  // Count failures observed in THIS call so the caller can reload prompt
  // resources even when zero extensions loaded — without this, a project
  // whose only extensions broke would update `loadFailures` but the
  // session's system prompt would not see the new failedExtensions list.
  let failedThisCall = 0;
  const wrappedHooks = {
    onLoaded: hooks?.onLoaded,
    onProjectLoaded: hooks?.onProjectLoaded,
    onFailure: hooks?.onFailure
      ? (f: Parameters<NonNullable<typeof hooks.onFailure>>[0]) => {
          failedThisCall += 1;
          hooks.onFailure?.(f);
        }
      : () => {
          failedThisCall += 1;
        },
  };
  for (const { projectRoot, extensionDir } of dirs) {
    await loadAethonExtensionDirectory(state, deps, api, registry, {
      dir: extensionDir,
      source: "project-directory",
      logPrefix: "aethon-project-ext",
      loadedFiles,
      failedFiles,
      displayName: (name) =>
        projectExtensionDisplayName(projectRoot, extensionDir, name),
      onLoaded: (name) => {
        wrappedHooks.onLoaded?.(name);
        wrappedHooks.onProjectLoaded?.(name, projectRoot);
      },
      onFailure: (failure) =>
        wrappedHooks.onFailure({ ...failure, projectRoot }),
    });
  }
  return { loaded: loadedFiles.size - before, failed: failedThisCall };
}
