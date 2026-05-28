/**
 * File viewer registry — the Monaco editor's extension hook.
 *
 * Built-ins (image, markdown-preview) live here. Extensions add their
 * own via `aethon.registerFileViewer({ extensions, componentType })`
 * — when an editor tab is opened for a file matching an entry, the
 * canvas dispatches the registered component type instead of mounting
 * Monaco. The component itself is a regular extension registration via
 * `aethon.registerComponent`, so extensions can ship a CSV table, a
 * PDF reader, a glb/3D viewer — anything Monaco isn't the right
 * surface for.
 *
 * Matching is by **lowercased extension** only for v1. Filename
 * patterns (Dockerfile-style) can layer in later; the registry's
 * `match` function is the only place that needs to change.
 */

interface FileViewerEntry {
  /** Lowercased extensions (without the leading dot) this viewer
   *  handles. e.g. ["png", "jpg", "jpeg", "gif", "webp"]. */
  extensions: string[];
  /** Registered component type to dispatch via the ExtensionRegistry. The
   *  component receives `{ filePath, tabId, projectPath }` props. */
  componentType: string;
}

const REGISTRY: FileViewerEntry[] = [];

/** Register (or replace) a file viewer entry. Idempotent on the
 *  same `componentType` — later registrations override earlier ones.
 *  Exposed to extensions via `aethon.registerFileViewer`. */
export function registerFileViewer(entry: FileViewerEntry): void {
  if (
    !entry ||
    !Array.isArray(entry.extensions) ||
    typeof entry.componentType !== "string"
  ) {
    return;
  }
  const idx = REGISTRY.findIndex((e) => e.componentType === entry.componentType);
  const normalized = {
    extensions: entry.extensions.map((e) => e.toLowerCase().replace(/^\./, "")),
    componentType: entry.componentType,
  };
  if (idx >= 0) REGISTRY[idx] = normalized;
  else REGISTRY.push(normalized);
}

/** Look up the registered viewer (if any) for a file path. Returns
 *  the matching `componentType` or `null` for "use Monaco". */
export function pickFileViewer(filePath: string): string | null {
  if (!filePath) return null;
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  for (const entry of REGISTRY) {
    if (entry.extensions.includes(ext)) return entry.componentType;
  }
  return null;
}

/** Test-only: reset registry between cases. */
export const __testing = {
  reset(): void {
    REGISTRY.length = 0;
  },
};

// Built-in viewers — registered eagerly at module load so they're in
// place before the first editor tab opens. Extensions later overriding
// the same componentType replace the React component, not this
// registry entry.
registerFileViewer({
  extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"],
  componentType: "image-viewer",
});
