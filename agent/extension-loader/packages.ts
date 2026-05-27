/**
 * npm-package extension loading. Walks
 * `~/.aethon/skills/node_modules/` (with one level of scoped namespace
 * recursion for `@org/pkg` layout), reads each `package.json` for an
 * `aethon` field, and loads `aethon.entry` (with optional
 * `aethon.frontendEntry` slurped into a string for the frontend to
 * eval).
 *
 * Disabled extensions short-circuit before importing. Failures emit
 * `extension_lifecycle` events with `status: "failed"` / `"skipped"`
 * so the sidebar's Failures group can render the user-facing message.
 */

import { readdir } from "node:fs/promises";
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
