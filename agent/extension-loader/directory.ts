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
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findProjectExtensionDirs,
  findProjectRoot,
} from "../project-extensions";
import { saveDisabledExtensionsSnapshot } from "../disabled-extensions";
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
  onDiscovered?: (name: string) => void;
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
  const filesystemCandidates = entries
    .filter((name) => /\.(ts|js|mjs)$/.test(name))
    .map((name) => ({
      name,
      file: join(options.dir, name),
      displayName:
        options.displayName?.(name) ?? name.replace(/\.(ts|js|mjs)$/, ""),
    }));
  for (const c of filesystemCandidates) {
    options.onDiscovered?.(c.displayName);
  }
  const allCandidates = filesystemCandidates.filter(
    (c) =>
      !options.loadedFiles?.has(c.file) && !options.failedFiles?.has(c.file),
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
      const prevHandlerOrdinals = new Map(state.currentExtensionHandlerOrdinals);
      state.currentExtensionLoadScope =
        options.source === "project-directory" ? "project" : "user";
      state.currentExtensionName = displayName;
      state.currentExtensionHandlerOrdinals.clear();
      try {
        await register(api);
      } finally {
        state.currentExtensionLoadScope = prevScope;
        state.currentExtensionName = prevExtName;
        state.currentExtensionHandlerOrdinals.clear();
        for (const [k, v] of prevHandlerOrdinals) {
          state.currentExtensionHandlerOrdinals.set(k, v);
        }
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

function projectDisplayPrefix(projectRoot: string, extensionDir: string): string {
  const scopeDir = dirname(dirname(extensionDir));
  const rootName = basename(projectRoot) || "project";
  const scope = relative(projectRoot, scopeDir).replace(/\\/g, "/");
  return scope && !scope.startsWith("..")
    ? `${rootName}/${scope}:`
    : `${rootName}:`;
}

function matchesProjectDisplayName(
  name: string,
  projectRoot: string,
  scannedPrefixes: ReadonlySet<string>,
): boolean {
  if ([...scannedPrefixes].some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  // If the whole extension directory disappeared, there are no scanned
  // prefixes. In that case only root-level legacy display names are safe to
  // treat as belonging to this project; nested scope names could refer to a
  // sibling cwd that was not part of the current scan.
  if (scannedPrefixes.size === 0) {
    const rootName = basename(projectRoot) || "project";
    return name.startsWith(`${rootName}:`);
  }
  return false;
}

async function pruneStaleDisabledProjectExtensions(
  state: AethonAgentState,
  projectRoot: string,
  discoveredNames: ReadonlySet<string>,
  scannedPrefixes: ReadonlySet<string>,
): Promise<number> {
  const normalizedProjectRoot = resolve(projectRoot);
  const stale: string[] = [];
  for (const name of state.disabledExtensions) {
    if (discoveredNames.has(name)) continue;
    const meta = state.disabledExtensionMeta.get(name);
    if (meta) {
      if (meta.source !== "project-directory") continue;
      if (meta.projectRoot && resolve(meta.projectRoot) !== normalizedProjectRoot) {
        continue;
      }
      if (matchesProjectDisplayName(name, projectRoot, scannedPrefixes)) {
        stale.push(name);
      }
      continue;
    }
    // Legacy entries predate source/projectRoot metadata. Prune only names
    // that match the active project's display-name prefix so package/user
    // disabled entries are not removed just because a project scan ran.
    if (matchesProjectDisplayName(name, projectRoot, scannedPrefixes)) {
      stale.push(name);
    }
  }
  if (stale.length === 0) return 0;
  const priorNames = new Set(state.disabledExtensions);
  const priorMeta = new Map(state.disabledExtensionMeta);
  for (const name of stale) {
    state.disabledExtensions.delete(name);
    state.disabledExtensionMeta.delete(name);
  }
  try {
    await saveDisabledExtensionsSnapshot(state.userDir, {
      names: state.disabledExtensions,
      meta: state.disabledExtensionMeta,
    });
    logger
      .scope("disabled-ext")
      .info(`pruned stale project disabled extensions: ${stale.join(", ")}`);
    return stale.length;
  } catch (err) {
    state.disabledExtensions.clear();
    for (const name of priorNames) state.disabledExtensions.add(name);
    state.disabledExtensionMeta.clear();
    for (const [name, meta] of priorMeta) {
      state.disabledExtensionMeta.set(name, meta);
    }
    logger
      .scope("disabled-ext")
      .warn(`prune stale disabled extensions: ${(err as Error).message}`);
    return 0;
  }
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
): Promise<{ loaded: number; failed: number; prunedDisabled: number }> {
  const dirs = await findProjectExtensionDirs(cwd);
  const projectRoot = dirs[0]?.projectRoot ?? (await findProjectRoot(cwd));
  const discoveredNames = new Set<string>();
  const scannedPrefixes = new Set<string>();
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
  for (const { projectRoot: dirProjectRoot, extensionDir } of dirs) {
    scannedPrefixes.add(projectDisplayPrefix(dirProjectRoot, extensionDir));
    await loadAethonExtensionDirectory(state, deps, api, registry, {
      dir: extensionDir,
      source: "project-directory",
      logPrefix: "aethon-project-ext",
      loadedFiles,
      failedFiles,
      displayName: (name) =>
        projectExtensionDisplayName(dirProjectRoot, extensionDir, name),
      onDiscovered: (name) => {
        discoveredNames.add(name);
      },
      onLoaded: (name) => {
        wrappedHooks.onLoaded?.(name);
        wrappedHooks.onProjectLoaded?.(name, dirProjectRoot);
      },
      onFailure: (failure) =>
        wrappedHooks.onFailure({ ...failure, projectRoot: dirProjectRoot }),
    });
  }
  const prunedDisabled = await pruneStaleDisabledProjectExtensions(
    state,
    projectRoot,
    discoveredNames,
    scannedPrefixes,
  );
  return {
    loaded: loadedFiles.size - before,
    failed: failedThisCall,
    prunedDisabled,
  };
}
