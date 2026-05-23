/**
 * Discovery + loading for Aethon extensions across all four sources:
 *
 *   1. **directory** — `~/.aethon/extensions/*.{ts,js,mjs}`. Bun runs .ts
 *      directly so authors don't need a build step.
 *   2. **project-directory** — `<project>/.aethon/extensions/*.{ts,...}`
 *      walked from the active cwd. Loaded on `set_project` / `tab_open`.
 *   3. **extension-package** — npm-style installs under
 *      `~/.aethon/skills/node_modules/`. Each package's `package.json`
 *      declares an `aethon` field with `entry` (and optional
 *      `frontendEntry`).
 *   4. **pi-extension** — discovered in `~/.pi/agent/extensions/` and
 *      observed to touch `globalThis.aethon`. We don't load these
 *      ourselves (pi does); we just record their existence.
 *
 * Plus loose-file themes from `~/.aethon/themes/*.json`, surfaced through
 * the same `registerTheme` path as extension-supplied ones.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { findProjectExtensionDirs } from "./project-extensions";
import { logger } from "./logger";
import { readSessionMetadata } from "./session-history";
import type {
  AethonAgentState,
  AethonExtensionApi,
  AethonExtensionModule,
  DiscoveredTab,
  ExtensionFailure,
  ExtensionFailureSource,
  ExtensionSource,
  ThemeRecord,
} from "./state";

/** Theme ids the frontend ships built-in CSS for (see src/styles/themes.css).
 *  Extensions can't reuse these — the frontend always seeds the sidebar
 *  with these labels and the rule comes from the static stylesheet. */
export const RESERVED_THEME_IDS = new Set([
  "ember",
  "paper",
  "aether",
  "signature",
  "brink",
]);

export interface ExtensionLoaderDeps {
  send: (obj: Record<string, unknown>) => void;
}

export interface LoadHooks {
  onLoaded?: (name: string) => void;
  onProjectLoaded?: (name: string, projectRoot: string) => void;
  onFailure?: (
    failure: ExtensionFailure & { name: string; source: ExtensionFailureSource },
  ) => void;
}

/** Validate theme metadata. The id is constrained to a slug so it's safe
 *  to embed in a CSS selector and a `<style>` element id; the variable
 *  names must look like CSS custom properties (`--*`). Variable values
 *  are passed through as-is — the frontend writes them via CSSOM
 *  `setProperty`, which silently rejects anything that would escape
 *  the declaration. Returns null when the input is too malformed to use
 *  (or collides with a reserved built-in id). */
export function normalizeTheme(input: unknown): ThemeRecord | null {
  if (!input || typeof input !== "object") return null;
  const t = input as { id?: unknown; label?: unknown; vars?: unknown };
  const id = typeof t.id === "string" ? t.id.trim() : "";
  if (!/^[A-Za-z][\w-]*$/.test(id)) return null;
  if (RESERVED_THEME_IDS.has(id)) return null;
  const label =
    typeof t.label === "string" && t.label.trim().length > 0
      ? t.label.trim()
      : id;
  const vars: Record<string, string> = {};
  if (t.vars && typeof t.vars === "object") {
    for (const [k, v] of Object.entries(t.vars as Record<string, unknown>)) {
      if (!/^--[A-Za-z0-9_-]+$/.test(k)) continue;
      if (typeof v !== "string") continue;
      vars[k] = v;
    }
  }
  return { id, label, vars };
}

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

interface LoadPackagesOptions {
  onFrontendEntry?: (entry: {
    name: string;
    entryPath: string;
    code: string;
  }) => void;
  onLoaded?: (name: string) => void;
  onFailure?: (failure: {
    name: string;
    source: "extension-package";
    status: "failed" | "skipped";
    error: string;
    path?: string;
  }) => void;
}

interface PackageCandidate {
  name: string;
  dir: string;
  manifest: {
    name?: string;
    aethon?: { entry?: string; frontendEntry?: string };
  };
}

export async function loadAethonExtensionPackages(
  state: AethonAgentState,
  deps: ExtensionLoaderDeps,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  options?: LoadPackagesOptions,
): Promise<void> {
  const skillsRoot = join(state.userDir, "skills", "node_modules");
  const candidates: PackageCandidate[] = [];

  async function readManifest(
    packageDir: string,
  ): Promise<PackageCandidate | null> {
    try {
      const pkgPath = join(packageDir, "package.json");
      const text = await Bun.file(pkgPath).text();
      const manifest = JSON.parse(text) as PackageCandidate["manifest"];
      if (!manifest.aethon) return null;
      return { name: manifest.name ?? packageDir, dir: packageDir, manifest };
    } catch {
      return null;
    }
  }

  let entries: string[];
  try {
    entries = await readdir(skillsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("ext-package")
        .warn(`readdir ${skillsRoot}: ${(err as Error).message}`);
    }
    return;
  }
  for (const entry of entries) {
    const entryPath = join(skillsRoot, entry);
    if (entry.startsWith("@")) {
      // Scoped namespace — recurse one level.
      let scoped: string[];
      try {
        scoped = await readdir(entryPath);
      } catch {
        continue;
      }
      for (const sub of scoped) {
        const c = await readManifest(join(entryPath, sub));
        if (c) candidates.push(c);
      }
    } else {
      const c = await readManifest(entryPath);
      if (c) candidates.push(c);
    }
  }
  for (const c of candidates) {
    if (state.disabledExtensions.has(c.name)) {
      logger.scope("ext-package").info(`${c.name}: disabled by user, skipping`);
      deps.send({
        type: "extension_lifecycle",
        name: c.name,
        source: "extension-package",
        status: "disabled",
        path: c.dir,
      });
      continue;
    }
    const entry = c.manifest.aethon?.entry;
    if (typeof entry !== "string" || entry.length === 0) {
      logger.scope("ext-package").warn(`${c.name}: aethon.entry not set, skipping`);
      deps.send({
        type: "extension_lifecycle",
        name: c.name,
        source: "extension-package",
        status: "skipped",
        error: "aethon.entry not set",
        path: c.dir,
      });
      options?.onFailure?.({
        name: c.name,
        source: "extension-package",
        status: "skipped",
        error: "aethon.entry not set",
        path: c.dir,
      });
      continue;
    }
    const filePath = join(c.dir, entry);
    try {
      const mod: AethonExtensionModule = await import(
        pathToFileURL(filePath).href
      );
      const register = mod.register ?? mod.default?.register;
      if (typeof register !== "function") {
        logger
          .scope("ext-package")
          .warn(`${c.name}: no register() export, skipping`);
        deps.send({
          type: "extension_lifecycle",
          name: c.name,
          source: "extension-package",
          status: "skipped",
          error: "no register() export",
          path: filePath,
        });
        options?.onFailure?.({
          name: c.name,
          source: "extension-package",
          status: "skipped",
          error: "no register() export",
          path: filePath,
        });
        continue;
      }
      const prevScope = state.currentExtensionLoadScope;
      const prevExtName = state.currentExtensionName;
      state.currentExtensionLoadScope = "user";
      state.currentExtensionName = c.name;
      try {
        await register(api);
      } finally {
        state.currentExtensionLoadScope = prevScope;
        state.currentExtensionName = prevExtName;
      }
      registry.set(c.name, "extension-package");
      options?.onLoaded?.(c.name);
      logger.scope("ext-package").info(`loaded ${c.name} from ${entry}`);
      deps.send({
        type: "extension_lifecycle",
        name: c.name,
        source: "extension-package",
        status: "loaded",
        path: filePath,
      });
      const frontendEntry = c.manifest.aethon?.frontendEntry;
      if (
        options?.onFrontendEntry &&
        typeof frontendEntry === "string" &&
        frontendEntry.length > 0
      ) {
        const fePath = join(c.dir, frontendEntry);
        try {
          const code = await Bun.file(fePath).text();
          options.onFrontendEntry({
            name: c.name,
            entryPath: fePath,
            code,
          });
          logger
            .scope("ext-package")
            .info(`${c.name}: frontend module shipped (${code.length} bytes)`);
        } catch (feErr) {
          const feMessage = (feErr as Error).message;
          logger
            .scope("ext-package")
            .warn(
              `${c.name}: failed to read frontendEntry ${fePath}: ${feMessage}`,
            );
          deps.send({
            type: "extension_lifecycle",
            name: `${c.name} (frontend)`,
            source: "extension-package",
            status: "failed",
            error: feMessage,
            path: fePath,
          });
          options?.onFailure?.({
            name: `${c.name} (frontend)`,
            source: "extension-package",
            status: "failed",
            error: feMessage,
            path: fePath,
          });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      logger.scope("ext-package").warn(`${c.name}: ${message}`);
      deps.send({
        type: "extension_lifecycle",
        name: c.name,
        source: "extension-package",
        status: "failed",
        error: message,
        path: filePath,
      });
      options?.onFailure?.({
        name: c.name,
        source: "extension-package",
        status: "failed",
        error: message,
        path: filePath,
      });
    }
  }
}

/** Discover pi extensions that touch `globalThis.aethon`. We grep each
 *  file for "globalThis.aethon" or "aethon.register" as a cheap signal of
 *  Aethon-awareness; non-Aethon pi extensions are skipped to keep the
 *  snapshot focused on UI-affecting code. */
export async function discoverPiAethonExtensions(
  registry: Map<string, ExtensionSource>,
): Promise<void> {
  const dir = join(homedir(), ".pi", "agent", "extensions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("pi-discover")
        .warn(`readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (!/\.(ts|js|mjs)$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      if (
        !text.includes("globalThis.aethon") &&
        !text.includes("aethon.register")
      ) {
        continue;
      }
      const display = name.replace(/\.(ts|js|mjs)$/, "");
      // Don't overwrite higher-precedence sources.
      if (!registry.has(display)) {
        registry.set(display, "pi-extension");
      }
    } catch {
      // Unreadable file — skip silently. Pi will surface its own load
      // error if the file is truly broken at import time.
    }
  }
}

/** Discover persisted per-tab sessions on disk under SESSIONS_DIR/<tabId>/. */
export async function discoverPersistedTabs(
  state: AethonAgentState,
): Promise<DiscoveredTab[]> {
  let entries: string[];
  try {
    entries = await readdir(state.sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("tabs")
        .warn(`readdir ${state.sessionsDir}: ${(err as Error).message}`);
    }
    return [];
  }
  const results: DiscoveredTab[] = [];
  for (const name of entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
    const dir = join(state.sessionsDir, name);
    try {
      const meta = await readSessionMetadata(dir);
      if (meta) results.push({ tabId: name, ...meta });
    } catch {
      /* skip — best effort */
    }
  }
  results.sort((a, b) => b.lastModified - a.lastModified);
  return results;
}

/** Discover and load loose-file themes from `~/.aethon/themes/*.json`. */
export async function loadAethonThemeDirectory(
  state: AethonAgentState,
  api: { registerTheme: (theme: unknown) => unknown },
): Promise<void> {
  const dir = join(state.userDir, "themes");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("themes")
        .warn(`readdir ${dir}: ${(err as Error).message}`);
    }
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const text = await Bun.file(file).text();
      const parsed = JSON.parse(text) as unknown;
      // registerTheme handles validation internally — invalid input emits
      // a notice and resolves with {ok:false}.
      api.registerTheme(parsed);
      logger.scope("themes").info(`loaded ${name}`);
    } catch (err) {
      logger.scope("themes").warn(`${name}: ${(err as Error).message}`);
    }
  }
}
