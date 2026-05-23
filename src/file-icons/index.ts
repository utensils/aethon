/**
 * iconForPath — resolve a filesystem entry to a vendored SVG URL.
 *
 * Resolution priority:
 *   1. Folder special cases (`.git`, `node_modules`, …) — distinct icon.
 *   2. Plain folder / open-folder fallback.
 *   3. Exact basename match (case-insensitive, e.g. `Cargo.toml`).
 *   4. Extension match (`.ts`, `.rs`, …).
 *   5. Generic file fallback.
 */

import {
  BY_BASENAME,
  BY_EXTENSION,
  BY_FOLDER_NAME,
  FALLBACK_FILE,
  FALLBACK_FOLDER,
  FALLBACK_FOLDER_OPEN,
  FALLBACK_FOLDER_ROOT,
  FALLBACK_FOLDER_ROOT_OPEN,
} from "./manifest";

export interface IconResult {
  src: string;
  /** Hint to the renderer when the source asset already encodes the
   *  open/closed glyph (folder-open.svg vs folder.svg) so no CSS flip
   *  is needed. */
  encodesState?: true;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function extensionOf(name: string): string | null {
  // Trim leading dot for dotfiles like `.gitignore` so they don't match
  // the BY_EXTENSION map by their entire name.
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return null; // dotfile or no ext
  return name.slice(idx + 1).toLowerCase();
}

export function iconForPath(
  name: string,
  isDir: boolean,
  options: { open?: boolean; isRoot?: boolean } = {},
): IconResult {
  const base = basenameOf(name);
  const baseLower = lower(base);

  if (isDir) {
    const special = BY_FOLDER_NAME[baseLower];
    if (special) {
      return { src: options.open ? special[1] : special[0] };
    }
    if (options.isRoot) {
      return {
        src: options.open ? FALLBACK_FOLDER_ROOT_OPEN : FALLBACK_FOLDER_ROOT,
        encodesState: true,
      };
    }
    return {
      src: options.open ? FALLBACK_FOLDER_OPEN : FALLBACK_FOLDER,
      encodesState: true,
    };
  }

  const exact = BY_BASENAME[baseLower];
  if (exact) return { src: exact };

  const ext = extensionOf(baseLower);
  if (ext) {
    const byExt = BY_EXTENSION[ext];
    if (byExt) return { src: byExt };
  }
  return { src: FALLBACK_FILE };
}
