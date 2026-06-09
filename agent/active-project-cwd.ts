import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface PersistedProject {
  id?: unknown;
  path?: unknown;
}

interface PersistedWorkspace {
  id?: unknown;
  projectId?: unknown;
  path?: unknown;
}

interface PersistedProjects {
  activeId?: unknown;
  activeWorkspaceId?: unknown;
  projects?: PersistedProject[];
  workspacesByProject?: Record<string, PersistedWorkspace[]>;
}

export function activeProjectCwdFromJson(text: string): string | undefined {
  let parsed: PersistedProjects;
  try {
    parsed = JSON.parse(text) as PersistedProjects;
  } catch {
    return undefined;
  }
  if (typeof parsed.activeId !== "string" || !parsed.activeId) return undefined;
  if (!Array.isArray(parsed.projects)) return undefined;
  const active = parsed.projects.find(
    (p) => p && typeof p.id === "string" && p.id === parsed.activeId,
  );
  const projectPath =
    active && typeof active.path === "string" && active.path.length > 0
      ? active.path
      : undefined;
  if (!projectPath) return undefined;

  if (typeof parsed.activeWorkspaceId === "string" && parsed.activeWorkspaceId) {
    const workspaces = parsed.workspacesByProject?.[parsed.activeId] ?? [];
    const activeWorkspace = workspaces.find(
      (w) =>
        w &&
        w.id === parsed.activeWorkspaceId &&
        w.projectId === parsed.activeId &&
        typeof w.path === "string" &&
        w.path.length > 0,
    );
    if (typeof activeWorkspace?.path === "string") return activeWorkspace.path;
  }

  return projectPath;
}

export async function readActiveProjectCwd(
  userDir: string,
): Promise<string | undefined> {
  try {
    return activeProjectCwdFromJson(
      await readFile(join(userDir, "projects.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

export function resolveStartupCwd(
  activeProjectCwd: string | undefined,
  projectRoot: string | undefined,
  userDir: string,
  processCwd: string,
): string {
  if (activeProjectCwd && activeProjectCwd.length > 0) return activeProjectCwd;
  if (projectRoot && projectRoot.length > 0) return projectRoot;
  if (userDir.length > 0) return userDir;
  return processCwd;
}
