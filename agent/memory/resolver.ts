import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectMemoryIdentity, ResolvedMemoryContext, ResolvedMemoryScope } from "./types";
import { readSqliteStateValue } from "../session-sqlite";

interface PersistedProject {
  id?: unknown;
  label?: unknown;
  path?: unknown;
}

interface PersistedWorkspace {
  id?: unknown;
  projectId?: unknown;
  path?: unknown;
}

interface PersistedProjects {
  projects?: PersistedProject[];
  workspacesByProject?: Record<string, PersistedWorkspace[]>;
  worktreesByProject?: Record<string, PersistedWorkspace[]>;
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;

export interface ResolveMemoryOptions {
  userDir: string;
  cwd: string;
  readProjectsJson?: () => Promise<string | undefined>;
  git?: (cwd: string, args: string[]) => Promise<string | undefined>;
}

function normalizePath(p: string): string {
  let out = resolve(p).replace(/[/\\]+$/, "");
  if (out === "") out = sep;
  return process.platform === "win32" ? out.toLowerCase() : out;
}

function canonicalPath(p: string): string {
  try {
    return normalizePath(realpathSync(p));
  } catch {
    return normalizePath(p);
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : `${p}${sep}`;
  return c.startsWith(prefix);
}

function slug(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function projectDirName(identity: ProjectMemoryIdentity): string {
  return `project-${shortHash(identity.key)}`;
}

function userScope(userDir: string): ResolvedMemoryScope {
  const dir = join(userDir, "memory", "user");
  return {
    scope: "user",
    dir,
    memoryPath: join(dir, "MEMORY.md"),
    topicsDir: join(dir, "topics"),
  };
}

function projectScope(userDir: string, identity: ProjectMemoryIdentity): ResolvedMemoryScope {
  const dir = join(userDir, "memory", "projects", projectDirName(identity));
  return {
    scope: "project",
    dir,
    memoryPath: join(dir, "MEMORY.md"),
    topicsDir: join(dir, "topics"),
    project: { ...identity, id: projectDirName(identity) },
  };
}

function cwdIdentity(cwd: string): ProjectMemoryIdentity {
  const root = canonicalPath(cwd);
  return {
    id: `${slug(basename(root))}-${shortHash(`cwd:${root}`)}`,
    key: `cwd:${root}`,
    root,
    label: basename(root) || "project",
    source: "cwd",
    resolvedFromCwd: cwd,
  };
}

export function projectIdentityFromProjectsJson(
  text: string | undefined,
  cwd: string,
): ProjectMemoryIdentity | undefined {
  if (!text) return undefined;
  let parsed: PersistedProjects;
  try {
    parsed = JSON.parse(text) as PersistedProjects;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.projects)) return undefined;

  const candidates: {
    root: string;
    matched: string;
    label: string;
    projectId: string;
    source: "aethon-project" | "aethon-workspace";
  }[] = [];
  const workspacesByProject = parsed.workspacesByProject ?? parsed.worktreesByProject ?? {};

  for (const p of parsed.projects) {
    if (typeof p?.id !== "string" || typeof p.path !== "string" || p.path.length === 0) {
      continue;
    }
    const label = typeof p.label === "string" && p.label.length > 0 ? p.label : basename(p.path);
    if (isInsidePath(cwd, p.path)) {
      candidates.push({ root: canonicalPath(p.path), matched: p.path, label, projectId: p.id, source: "aethon-project" });
    }
    const workspaces = workspacesByProject[p.id] ?? [];
    for (const w of workspaces) {
      if (w?.projectId !== p.id || typeof w.path !== "string" || w.path.length === 0) continue;
      if (isInsidePath(cwd, w.path)) {
        candidates.push({ root: canonicalPath(p.path), matched: w.path, label, projectId: p.id, source: "aethon-workspace" });
      }
    }
  }

  candidates.sort((a, b) => canonicalPath(b.matched).length - canonicalPath(a.matched).length);
  const best = candidates[0];
  if (!best) return undefined;
  return {
    id: best.projectId,
    key: `aethon-project:${best.projectId}:${best.root}`,
    root: best.root,
    label: best.label,
    source: best.source,
    resolvedFromCwd: cwd,
  };
}

async function defaultReadProjectsJson(userDir: string): Promise<string | undefined> {
  const sqliteProjects = readSqliteStateValue("projects.json");
  if (sqliteProjects !== undefined) return sqliteProjects;
  try {
    return await readFile(join(userDir, "projects.json"), "utf8");
  } catch {
    return undefined;
  }
}

async function defaultGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const out = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    const text = out.stdout.trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

async function projectIdentityFromGit(
  cwd: string,
  git: (cwd: string, args: string[]) => Promise<string | undefined>,
): Promise<ProjectMemoryIdentity | undefined> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!common && !top) return undefined;

  let root: string | undefined;
  let source: ProjectMemoryIdentity["source"] = "git-toplevel";
  if (common) {
    const commonPath = canonicalPath(common);
    if (basename(commonPath) === ".git") {
      root = canonicalPath(dirname(commonPath));
      source = "git-common-dir";
    }
  }
  root ??= top ? canonicalPath(top) : undefined;
  if (!root) return undefined;
  return {
    id: `${slug(basename(root))}-${shortHash(`git:${root}`)}`,
    key: `git:${root}`,
    root,
    label: basename(root) || "project",
    source,
    resolvedFromCwd: cwd,
  };
}

function writeIfChanged(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {
    // Missing or unreadable files are replaced below.
  }
  writeFileSync(path, text, "utf8");
}

function ensureScope(scope: ResolvedMemoryScope): void {
  mkdirSync(scope.topicsDir, { recursive: true });
  if (!existsSync(scope.memoryPath)) {
    writeFileSync(scope.memoryPath, "", "utf8");
  }
  if (scope.scope === "project" && scope.project) {
    const metaPath = join(scope.dir, "meta.json");
    writeIfChanged(
      metaPath,
      `${JSON.stringify(
        {
          id: scope.project.id,
          key: scope.project.key,
          root: scope.project.root,
          label: scope.project.label,
          source: scope.project.source,
        },
        null,
        2,
      )}\n`,
    );
  }
}

export async function resolveMemoryContext(
  options: ResolveMemoryOptions,
): Promise<Omit<ResolvedMemoryContext, "userMemory" | "projectMemory">> {
  const user = userScope(options.userDir);
  const projectsJson = options.readProjectsJson
    ? await options.readProjectsJson()
    : await defaultReadProjectsJson(options.userDir);
  const identity =
    projectIdentityFromProjectsJson(projectsJson, options.cwd) ??
    (await projectIdentityFromGit(options.cwd, options.git ?? defaultGit)) ??
    cwdIdentity(options.cwd);
  const project = projectScope(options.userDir, identity);
  ensureScope(user);
  ensureScope(project);
  return { user, project };
}

export async function resolveMemoryScope(
  options: ResolveMemoryOptions & { scope: "user" | "project" },
): Promise<ResolvedMemoryScope> {
  const ctx = await resolveMemoryContext(options);
  return options.scope === "user" ? ctx.user : ctx.project;
}

export function readMemoryPath(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
