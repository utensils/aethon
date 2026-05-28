import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ProjectExtensionDir {
  /** Nearest git root, or the starting cwd when no git root is found. */
  projectRoot: string;
  /** Existing `.aethon/extensions` directory to load. */
  extensionDir: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function nearestGitRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await pathExists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve the nearest project root for a cwd using the same rules as
 *  project extension discovery. Falls back to the normalized starting
 *  directory when no `.git` marker is found. */
export async function findProjectRoot(cwd: string): Promise<string> {
  const start = await normalizeStartDirectory(cwd);
  return (await nearestGitRoot(start)) ?? start;
}

async function normalizeStartDirectory(cwd: string): Promise<string> {
  const start = resolve(cwd);
  try {
    const s = await stat(start);
    return s.isDirectory() ? start : dirname(start);
  } catch {
    return start;
  }
}

/**
 * Find project-local Aethon extension directories between cwd and the
 * nearest git root. Results are root-first so nested project directories can
 * intentionally override parent-level components/themes/layouts.
 */
export async function findProjectExtensionDirs(
  cwd: string,
): Promise<ProjectExtensionDir[]> {
  const start = await normalizeStartDirectory(cwd);
  const root = await findProjectRoot(start);
  const dirs: ProjectExtensionDir[] = [];
  let dir = start;

  for (;;) {
    const extensionDir = join(dir, ".aethon", "extensions");
    if (await isDirectory(extensionDir)) {
      dirs.push({ projectRoot: root, extensionDir });
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs.reverse();
}
