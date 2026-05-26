import type {
  DisabledExtensionRecord,
  ExtensionKind,
  ExtensionSummary,
} from "./types";

export function normalizeExtensionProjectPath(
  path: string | undefined | null,
): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

/** Parse the scope segment from an npm-scoped package name
 *  (`@scope/pkg` → `scope`). Returns null when the name isn't scoped. */
export function extractNpmScope(name: string): string | null {
  if (!name.startsWith("@")) return null;
  const slash = name.indexOf("/");
  if (slash <= 1) return null;
  return name.slice(1, slash);
}

export function basenameOfPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

export function filterExtensionSummariesByProject<T extends ExtensionSummary>(
  entries: T[],
  activeProjectPath: string | null = null,
  knownProjectBasenames: ReadonlySet<string> = new Set(),
): T[] {
  const activePath = normalizeExtensionProjectPath(activeProjectPath);
  const activeBasename = basenameOfPath(activePath);
  return entries.filter((entry) => {
    if (entry.source === "project-directory") {
      const projectRoot = normalizeExtensionProjectPath(entry.projectRoot);
      return (
        activePath.length > 0 &&
        projectRoot.length > 0 &&
        (activePath === projectRoot || activePath.startsWith(`${projectRoot}/`))
      );
    }
    // npm-scoped packages whose scope matches a known project basename
    // are treated as belonging to that project — convention `@project/ext`.
    // Other scopes (`@example/…`, `@me/…`) stay global because we have
    // no reason to associate them with any specific project.
    if (entry.source === "extension-package") {
      const scope = extractNpmScope(entry.name);
      if (scope && knownProjectBasenames.has(scope)) {
        return scope === activeBasename;
      }
      return true;
    }
    return true;
  });
}

/** Map the bridge-side `ExtensionSource` enum onto the two user-visible
 *  buckets. Project-scoped covers both `.aethon/extensions` inside the
 *  active project AND npm packages whose `@scope` matches the active
 *  project's basename (the `@<project>/<ext>` convention). Everything
 *  else — global `~/.aethon/extensions`, npm packages with an unrelated
 *  scope, and legacy disabled records lacking source metadata — falls
 *  into the user bucket. */
export function classifyExtensionSource(
  source: string | undefined,
  options?: {
    name?: string;
    activeBasename?: string;
    knownProjectBasenames?: ReadonlySet<string>;
  },
): ExtensionKind {
  if (source === "project-directory") return "project";
  if (source === "extension-package") {
    // `@<project>/<ext>` npm convention — when the npm scope matches
    // the active project's directory basename, surface it under the
    // project group. The knownProjectBasenames guard prevents a
    // random `@<anything>/...` package from masquerading as
    // project-scoped just because its scope happens to share a name
    // with no real project.
    const name = options?.name;
    const activeBasename = options?.activeBasename;
    const known = options?.knownProjectBasenames;
    if (name && activeBasename) {
      const scope = extractNpmScope(name);
      if (scope && scope === activeBasename && (known?.has(scope) ?? false)) {
        return "project";
      }
    }
    return "user";
  }
  return "user";
}

export function normalizeDisabledRecord(
  entry: DisabledExtensionRecord | string,
): DisabledExtensionRecord {
  return typeof entry === "string" ? { name: entry } : entry;
}

/** Extract the parent project root-name from a project-directory
 *  display name. The bridge formats these as `<rootName>(/scope)?:<base>`
 *  (see `projectExtensionDisplayName` in agent/extension-loader.ts).
 *  Returns null if the name doesn't look like that format. */
export function extractProjectDirectoryRootName(name: string): string | null {
  // npm-scoped names (`@scope/pkg`) are extension-packages, not
  // project-directory entries — bail before they trip the `:` test.
  if (name.startsWith("@")) return null;
  const colonIdx = name.indexOf(":");
  if (colonIdx <= 0) return null;
  const prefix = name.slice(0, colonIdx);
  const root = prefix.split("/")[0];
  // Conservative shape: the root name comes from `basename(projectRoot)`,
  // so it can include any filesystem-legal chars. Reject anything with
  // whitespace or path separators that suggest the `:` was incidental
  // (e.g. `windows:c\path` would be a malformed name, not a real
  // project-directory display name).
  return /^[^\s\\]+$/.test(root) ? root : null;
}

/** Decide whether a disabled-row entry should appear given the active
 *  project. Project-directory entries with explicit `projectRoot`
 *  metadata are scoped strictly. Legacy bare-name entries (no source —
 *  written before the v0.3 schema upgrade) fall back to a name-shape
 *  heuristic: if the name parses as a project-directory display name
 *  (`<rootName>(/scope)?:<base>`), match `rootName` to the active
 *  project's basename. npm-scoped extension-packages whose scope
 *  matches a known project basename are also treated as project-scoped
 *  (convention: `@project/ext`); other scopes stay global. */
export function disabledExtensionMatchesProject(
  record: DisabledExtensionRecord,
  activeProjectPath: string | null,
  knownProjectBasenames: ReadonlySet<string> = new Set(),
): boolean {
  if (record.source === "project-directory") {
    const activePath = normalizeExtensionProjectPath(activeProjectPath);
    const projectRoot = normalizeExtensionProjectPath(record.projectRoot);
    return (
      activePath.length > 0 &&
      projectRoot.length > 0 &&
      (activePath === projectRoot || activePath.startsWith(`${projectRoot}/`))
    );
  }
  const activePath = normalizeExtensionProjectPath(activeProjectPath);
  const activeBasename = basenameOfPath(activePath);
  // npm scope → project name convention. Applies to extension-package
  // entries AND to legacy bare entries whose name happens to start with
  // `@scope/...` (both reach this branch).
  const scope = extractNpmScope(record.name);
  if (scope && knownProjectBasenames.has(scope)) {
    return scope === activeBasename;
  }
  // Entries with an explicit non-project-directory source are global.
  if (record.source) return true;
  // Legacy heuristic — see comment above.
  const heuristicRoot = extractProjectDirectoryRootName(record.name);
  if (heuristicRoot === null) return true;
  if (activePath.length === 0) return false;
  return activeBasename === heuristicRoot;
}
