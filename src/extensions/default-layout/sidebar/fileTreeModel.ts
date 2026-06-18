interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
}

type GitFileStatusKind =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted";

interface GitFileStatusEntry {
  path: string;
  status: GitFileStatusKind;
  originalPath?: string | null;
}

interface GitDecoration {
  status: GitFileStatusKind;
  source: "direct" | "descendant";
}

interface GitStatusMeta {
  label: string;
  title: string;
}

/** A node in the in-memory tree. `children` is undefined until the
 *  folder has been loaded; null means "load attempted, no children". */
interface TreeNode {
  entry: FsEntry;
  depth: number;
  children?: TreeNode[] | null;
  loading?: boolean;
  loadError?: string;
}

interface EditorTabShape {
  id?: string;
  kind?: string;
  cwd?: string;
  waiting?: boolean;
  editor?: {
    rootPath?: string;
    filePath?: string;
  };
}

/** Persisted expand-state. Each project keeps its own set of expanded
 *  absolute paths so reopening lands on the prior view. Capped per
 *  project to bound the persisted file's size. */
interface ExpandedStore {
  byProject: Record<string, string[]>;
}

interface ProjectShape {
  path?: string;
  name?: string;
}

interface ContextMenuState {
  rootPath: string;
  x: number;
  y: number;
  node: TreeNode;
}

interface GitDecorations {
  direct: Map<string, GitFileStatusKind>;
  descendants: Map<string, GitFileStatusKind>;
}

const GIT_STATUS_META: Record<GitFileStatusKind, GitStatusMeta> = {
  modified: { label: "M", title: "Modified" },
  added: { label: "A", title: "Added" },
  untracked: { label: "U", title: "Untracked" },
  deleted: { label: "D", title: "Deleted" },
  renamed: { label: "R", title: "Renamed" },
  copied: { label: "C", title: "Copied" },
  conflicted: { label: "!", title: "Conflicted" },
};

const GIT_STATUS_PRIORITY: Record<GitFileStatusKind, number> = {
  conflicted: 70,
  deleted: 60,
  renamed: 50,
  added: 40,
  untracked: 30,
  copied: 20,
  modified: 10,
};

const EXPAND_STATE_FILE = "file-tree.json";
const EXPANDED_CAP_PER_PROJECT = 200;

function basename(path: string): string {
  return (
    path
      .split(/[/\\]+/)
      .filter(Boolean)
      .pop() ?? path
  );
}

function dirname(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(0, slash) : "";
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function relativePathFor(rootPath: string, path: string): string | null {
  if (!rootPath || !path) return null;
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = path.replace(/\\/g, "/");
  if (target === root) return "";
  if (target.startsWith(`${root}/`)) {
    return normalizeRelativePath(target.slice(root.length + 1));
  }
  return null;
}

/** Join a root + a (forward-slash) relative path, picking the OS separator
 *  from the root so file-tree-derived and SCM-panel-derived paths for the
 *  same file are byte-identical (matters for editor-tab dedupe on Windows
 *  backslash roots). The canonical path-join for the whole files surface. */
export function absolutePathFor(
  rootPath: string,
  relativePath: string,
): string {
  const separator =
    rootPath.includes("\\") && !rootPath.includes("/") ? "\\" : "/";
  const normalizedRelative = normalizeRelativePath(relativePath).replace(
    /\//g,
    separator,
  );
  return `${rootPath.replace(/[\\/]+$/, "")}${separator}${normalizedRelative}`;
}

/** Absolute paths of every directory between `rootPath` (exclusive) and
 *  `filePath` (exclusive), in root → leaf order — i.e. the folders the file
 *  tree must expand to reveal the file. Empty when the file is outside the
 *  root or sits directly under it. Uses the root's separator so the paths
 *  match the tree's node keys (matters on Windows backslash roots). */
export function ancestorDirsFor(rootPath: string, filePath: string): string[] {
  const rel = relativePathFor(rootPath, filePath);
  if (rel == null || rel === "") return [];
  const segments = rel.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    dirs.push(absolutePathFor(rootPath, segments.slice(0, i).join("/")));
  }
  return dirs;
}

function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentRelativePath(relativePath: string): string {
  return dirname(normalizeRelativePath(relativePath)).replace(/^\/+/, "");
}

function strongerGitStatus(
  a: GitFileStatusKind | undefined,
  b: GitFileStatusKind,
): GitFileStatusKind {
  if (!a) return b;
  return GIT_STATUS_PRIORITY[b] > GIT_STATUS_PRIORITY[a] ? b : a;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.entry.kind !== b.entry.kind) {
      return a.entry.kind === "dir" ? -1 : 1;
    }
    return a.entry.name.toLowerCase().localeCompare(b.entry.name.toLowerCase());
  });
}

function gitStatusesFromEntries(
  entries: GitFileStatusEntry[] | null | undefined,
): Map<string, GitFileStatusEntry> {
  const map = new Map<string, GitFileStatusEntry>();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path);
    if (!path) continue;
    map.set(path, { ...entry, path });
  }
  return map;
}

/** Return the directory of `node`'s entry: the node itself when it's a
 *  folder, the containing folder when it's a file. Used by the
 *  context menu's New File / New Folder actions to anchor at the
 *  right location regardless of which row the user right-clicked. */
function parentDirOf(node: TreeNode): string {
  if (node.entry.kind === "dir") return node.entry.path;
  const slash = Math.max(
    node.entry.path.lastIndexOf("/"),
    node.entry.path.lastIndexOf("\\"),
  );
  return slash >= 0 ? node.entry.path.slice(0, slash) : node.entry.path;
}

function withDepth(node: TreeNode, depth: number): TreeNode {
  const delta = depth - node.depth;
  if (delta === 0) return node;
  const walk = (current: TreeNode): TreeNode => ({
    ...current,
    depth: current.depth + delta,
    children: current.children?.map(walk) ?? current.children,
  });
  return walk(node);
}

function nodesFromEntries(
  entries: FsEntry[],
  depth: number,
  previousChildren?: TreeNode[] | null,
): TreeNode[] {
  const previousByPath = new Map(
    (previousChildren ?? []).map((child) => [child.entry.path, child]),
  );
  return entries.map((entry) => {
    const previous = previousByPath.get(entry.path);
    if (!previous) return { entry, depth };
    return {
      ...withDepth(previous, depth),
      entry,
      loadError: undefined,
    };
  });
}

/** Return a copy of `root` with `folderPath`'s children replaced by nodes
 *  built from `entries` (at the right depth, preserving already-loaded
 *  grandchildren). Shared by the initial expanded-folder restore and
 *  expand-all so the lazy-load graft logic lives in one place. */
function graftChildren(
  root: TreeNode,
  folderPath: string,
  entries: FsEntry[],
): TreeNode {
  const walk = (node: TreeNode): TreeNode => {
    if (node.entry.path === folderPath) {
      return {
        ...node,
        children: nodesFromEntries(entries, node.depth + 1, node.children),
      };
    }
    if (!node.children) return node;
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/** Parse the persisted store; tolerate corruption by returning empty. */
function parseExpandedStore(raw: string): ExpandedStore {
  if (!raw) return { byProject: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "byProject" in parsed &&
      typeof parsed.byProject === "object"
    ) {
      const map = parsed.byProject as Record<string, unknown>;
      const cleaned: Record<string, string[]> = {};
      for (const [projectPath, list] of Object.entries(map)) {
        if (Array.isArray(list)) {
          cleaned[projectPath] = list.filter(
            (p): p is string => typeof p === "string",
          );
        }
      }
      return { byProject: cleaned };
    }
  } catch {
    /* fall through */
  }
  return { byProject: {} };
}

function gitDecorationsFromStatuses(
  gitStatuses: Map<string, GitFileStatusEntry>,
): GitDecorations {
  const direct = new Map<string, GitFileStatusKind>();
  const descendants = new Map<string, GitFileStatusKind>();
  for (const [path, entry] of gitStatuses) {
    direct.set(path, entry.status);
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      descendants.set(
        dir,
        strongerGitStatus(descendants.get(dir), entry.status),
      );
    }
  }
  return { direct, descendants };
}

interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
}

/** Build a matcher from git-ignored paths (as returned by `git_ignored_paths`,
 *  relative to the active root). Entries ending in `/` are directory prefixes
 *  that dim their whole subtree (e.g. `node_modules/` collapses to one entry
 *  yet greys every descendant); others are exact files. An empty list matches
 *  nothing, so a clean / non-git tree renders undimmed.
 *
 *  Special case: when the active root is itself ignored by a parent
 *  `.gitignore` (e.g. opening `repo/build` where `/build/` is ignored),
 *  `git ls-files --directory -- .` reports `./` — meaning *everything* under
 *  the root is ignored. That normalizes to `.`, which can't match children as
 *  a normal prefix, so treat it as a blanket match instead. */
function buildIgnoreMatcher(paths: string[] | null | undefined): IgnoreMatcher {
  const exact = new Set<string>();
  const dirs: string[] = [];
  let rootIgnored = false;
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== "string") continue;
    const isDir = /[/\\]$/.test(raw);
    const norm = normalizeRelativePath(raw);
    if (norm === "" || norm === ".") {
      rootIgnored = true;
      continue;
    }
    if (isDir) dirs.push(norm);
    else exact.add(norm);
  }
  return {
    isIgnored(relativePath: string): boolean {
      if (rootIgnored) return true;
      const rel = normalizeRelativePath(relativePath);
      if (!rel) return false;
      if (exact.has(rel)) return true;
      return dirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
    },
  };
}

function deletedChildrenByParentFromStatuses(
  gitStatuses: Map<string, GitFileStatusEntry>,
  projectPath: string,
): Map<string, FsEntry[]> {
  const byParent = new Map<string, FsEntry[]>();
  if (!projectPath) return byParent;
  for (const [path, entry] of gitStatuses) {
    if (entry.status !== "deleted") continue;
    const parent = parentRelativePath(path);
    const children = byParent.get(parent) ?? [];
    children.push({
      name: basename(path),
      path: absolutePathFor(projectPath, path),
      kind: "file",
    });
    byParent.set(parent, children);
  }
  return byParent;
}

function visibleTreeNodes({
  root,
  expanded,
  projectPath,
  deletedChildrenByParent,
}: {
  root: TreeNode | null;
  expanded: Set<string>;
  projectPath: string;
  deletedChildrenByParent: Map<string, FsEntry[]>;
}): TreeNode[] {
  if (!root) return [];
  const out: TreeNode[] = [];
  const childrenFor = (node: TreeNode): TreeNode[] => {
    const children = node.children ?? [];
    const parentRel = projectPath
      ? relativePathFor(projectPath, node.entry.path)
      : null;
    const deleted =
      parentRel == null ? [] : (deletedChildrenByParent.get(parentRel) ?? []);
    if (deleted.length === 0) return children;
    const existing = new Set(
      children.map((child) => normalizeAbsolutePath(child.entry.path)),
    );
    const synthetic = deleted
      .filter((entry) => !existing.has(normalizeAbsolutePath(entry.path)))
      .map((entry) => ({ entry, depth: node.depth + 1 }));
    return sortTreeNodes([...children, ...synthetic]);
  };
  const walk = (node: TreeNode) => {
    out.push(node);
    if (node.entry.kind !== "dir") return;
    if (!expanded.has(node.entry.path)) return;
    for (const child of childrenFor(node)) walk(child);
  };
  for (const child of childrenFor(root)) walk(child);
  return out;
}

function watchedDirsFor({
  projectPath,
  expanded,
  hidden,
}: {
  projectPath: string;
  expanded: Set<string>;
  hidden: boolean;
}): string[] {
  if (!projectPath || hidden) return [];
  const dirs = new Set<string>([projectPath]);
  for (const p of expanded) {
    dirs.add(p);
  }
  return [...dirs].sort();
}

export {
  EXPANDED_CAP_PER_PROJECT,
  EXPAND_STATE_FILE,
  GIT_STATUS_META,
  basename,
  buildIgnoreMatcher,
  deletedChildrenByParentFromStatuses,
  gitDecorationsFromStatuses,
  gitStatusesFromEntries,
  graftChildren,
  nodesFromEntries,
  parentDirOf,
  parseExpandedStore,
  relativePathFor,
  visibleTreeNodes,
  watchedDirsFor,
};

export type {
  ContextMenuState,
  EditorTabShape,
  ExpandedStore,
  FsEntry,
  GitDecoration,
  GitFileStatusEntry,
  GitFileStatusKind,
  IgnoreMatcher,
  ProjectShape,
  TreeNode,
};
