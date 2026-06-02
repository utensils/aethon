function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "" : normalized.slice(0, idx);
}

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? "";
  const body = drive ? slashed.slice(drive.length) : slashed;
  const absolute = Boolean(drive) || body.startsWith("/");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? `${drive}/` : absolute ? "/" : "";
  return `${prefix}${parts.join("/")}`;
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

function isInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path).replace(/\/+$/, "");
  const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
  if (!normalizedRoot) return true;
  const caseInsensitive = /^[A-Za-z]:/.test(normalizedRoot);
  const candidate = caseInsensitive
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const boundary = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
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
  const fileUrl = linkPath.startsWith("file://");
  if (fileUrl) {
    try {
      linkPath = new URL(linkPath).pathname;
    } catch {
      return null;
    }
  }

  const decoded = decodeHrefPath(linkPath);
  if (!decoded) return null;

  const projectRoot = normalizePath(projectPath).replace(/\/+$/, "");
  let resolved: string;
  if (decoded.startsWith("/")) {
    const normalizedDecoded = normalizePath(decoded);
    if (projectRoot && !isInsideRoot(normalizedDecoded, projectRoot)) {
      if (fileUrl) return null;
      resolved = normalizePath(`${projectRoot}${normalizedDecoded}`);
    } else {
      resolved = normalizedDecoded;
    }
  } else {
    const baseDir = dirname(currentFilePath) || projectRoot;
    resolved = baseDir
      ? normalizePath(`${baseDir.replace(/\/+$/, "")}/${decoded}`)
      : normalizePath(decoded);
  }

  if (projectRoot && !isInsideRoot(resolved, projectRoot)) return null;
  return resolved;
}

export function safeExternalHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}
