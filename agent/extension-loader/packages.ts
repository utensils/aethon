/**
 * npm-package extension loading. Walks
 * `~/.aethon/extensions/node_modules/` (with one level of scoped namespace
 * recursion for `@org/pkg` layout), reads each `package.json` for an
 * `aethon` field, and loads `aethon.entry` (with optional
 * `aethon.frontendEntry` slurped into a string for the frontend to
 * eval).
 *
 * Disabled extensions short-circuit before importing. Failures emit
 * `extension_lifecycle` events with `status: "failed"` / `"skipped"`
 * so the sidebar's Failures group can render the user-facing message.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger";
import type {
  AethonAgentState,
  AethonExtensionApi,
  AethonExtensionModule,
  ExtensionSource,
} from "../state";
import type { ExtensionLoaderDeps } from "./shared";

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

interface PackageManifest {
  name?: string;
  aethon?: { entry?: string; frontendEntry?: string };
}

interface PackageCandidate {
  name: string;
  dir: string;
  manifest: PackageManifest;
}

interface PackageManifestFailure {
  name: string;
  path: string;
  error: string;
}

export async function loadAethonExtensionPackages(
  state: AethonAgentState,
  deps: ExtensionLoaderDeps,
  api: AethonExtensionApi,
  registry: Map<string, ExtensionSource>,
  options?: LoadPackagesOptions,
): Promise<void> {
  const candidates = new Map<string, PackageCandidate>();

  async function readManifest(
    packageDir: string,
    fallbackName: string,
  ): Promise<PackageCandidate | PackageManifestFailure | null> {
    const pkgPath = join(packageDir, "package.json");
    try {
      const text = await readFile(pkgPath, "utf8");
      const manifest = JSON.parse(text) as PackageManifest;
      if (!manifest.aethon) return null;
      return { name: manifest.name ?? fallbackName, dir: packageDir, manifest };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      return {
        name: fallbackName,
        path: pkgPath,
        error: `package.json: ${(err as Error).message}`,
      };
    }
  }

  function recordManifestFailure(failure: PackageManifestFailure) {
    logger.scope("ext-package").warn(`${failure.name}: ${failure.error}`);
    deps.send({
      type: "extension_lifecycle",
      name: failure.name,
      source: "extension-package",
      status: "failed",
      error: failure.error,
      path: failure.path,
    });
    options?.onFailure?.({
      name: failure.name,
      source: "extension-package",
      status: "failed",
      error: failure.error,
      path: failure.path,
    });
  }

  async function discoverPackages(
    root: string,
    options?: { skipNodeModules?: boolean },
  ) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger
          .scope("ext-package")
          .warn(`readdir ${root}: ${(err as Error).message}`);
      }
      return;
    }
    // Read every manifest concurrently, then record the results in the
    // original entry order — candidate insertion is first-wins and
    // failure events are user-visible, so ordering stays deterministic.
    const slots = await Promise.all(
      entries.map(
        async (
          entry,
        ): Promise<Array<PackageCandidate | PackageManifestFailure | null>> => {
          if (options?.skipNodeModules && entry === "node_modules") return [];
          const entryPath = join(root, entry);
          if (entry.startsWith("@")) {
            // Scoped namespace — recurse one level.
            let scoped: string[];
            try {
              scoped = await readdir(entryPath);
            } catch {
              return [];
            }
            return Promise.all(
              scoped.map((sub) =>
                readManifest(join(entryPath, sub), `${entry}/${sub}`),
              ),
            );
          }
          return [await readManifest(entryPath, entry)];
        },
      ),
    );
    for (const slot of slots) {
      for (const result of slot) {
        if (!result) continue;
        if ("manifest" in result) {
          if (!candidates.has(result.name)) candidates.set(result.name, result);
        } else {
          recordManifestFailure(result);
        }
      }
    }
  }

  await discoverPackages(join(state.userDir, "extensions"), {
    skipNodeModules: true,
  });
  await discoverPackages(join(state.userDir, "extensions", "node_modules"));

  // Filter pass: disabled / missing-entry candidates emit their lifecycle
  // events in discovery order, exactly as before.
  const loadable: Array<{
    c: PackageCandidate;
    entry: string;
    filePath: string;
  }> = [];
  for (const c of candidates.values()) {
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
      logger
        .scope("ext-package")
        .warn(`${c.name}: aethon.entry not set, skipping`);
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
    loadable.push({ c, entry, filePath: join(c.dir, entry) });
  }

  // Parallelize the entry imports (mirrors directory.ts); register()
  // stays sequential in discovery order so registrations against shared
  // maps stay deterministic.
  const imports = await Promise.allSettled(
    loadable.map(
      ({ filePath }) =>
        import(pathToFileURL(filePath).href) as Promise<AethonExtensionModule>,
    ),
  );

  for (let i = 0; i < loadable.length; i++) {
    const { c, entry, filePath } = loadable[i];
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
      const prevHandlerOrdinals = new Map(state.currentExtensionHandlerOrdinals);
      state.currentExtensionLoadScope = "user";
      state.currentExtensionName = c.name;
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
          const code = await readFile(fePath, "utf8");
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
