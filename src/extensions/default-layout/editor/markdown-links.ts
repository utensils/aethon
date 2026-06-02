function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "" : normalized.slice(0, idx);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function stripHashAndQuery(href: string): string {
  const hashIdx = href.indexOf("#");
  const queryIdx = href.indexOf("?");
  const indexes = [hashIdx, queryIdx].filter((idx) => idx >= 0);
  if (indexes.length === 0) return href;
  return href.slice(0, Math.min(...indexes));
}

function hasExternalScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:");
}

function decodeHrefPath(href: string): string | null {
  try {
    return decodeURIComponent(href);
  } catch {
    return null;
  }
}

export function resolveMarkdownLinkPath(
  href: string | undefined,
  currentFilePath: string,
  projectPath: string,
): string | null {
  const raw = (href ?? "").trim();
  if (!raw || raw.startsWith("#") || hasExternalScheme(raw)) return null;

  const withoutFragment = stripHashAndQuery(raw);
  if (!withoutFragment) return null;

  let linkPath = withoutFragment;
  if (linkPath.startsWith("file://")) {
    try {
      linkPath = new URL(linkPath).pathname;
    } catch {
      return null;
    }
  }

  const decoded = decodeHrefPath(linkPath);
  if (!decoded) return null;

  const projectRoot = projectPath.replace(/\/+$/, "");
  if (decoded.startsWith("/")) {
    if (projectRoot && !decoded.startsWith(`${projectRoot}/`)) {
      return normalizePath(`${projectRoot}${decoded}`);
    }
    return normalizePath(decoded);
  }

  const baseDir = dirname(currentFilePath) || projectPath;
  if (!baseDir) return normalizePath(decoded);
  return normalizePath(`${baseDir.replace(/\/+$/, "")}/${decoded}`);
}
