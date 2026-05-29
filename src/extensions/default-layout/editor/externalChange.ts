/**
 * External-change detection helpers — pure logic for deciding whether a
 * file-watcher event touches the open editor file and what to do about a
 * newer on-disk mtime. Kept framework-free so the branching is unit
 * tested without mocking the Tauri event bus; `useEditorExternalChange`
 * is the thin hook that wires this to `fs-tree-changed` + `fs_file_mtime`.
 */

/** The directory containing `filePath` (handles both separators). */
export function parentDir(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : "";
}

/** Whether a `fs-tree-changed` payload could have touched `filePath`. The
 *  watcher reports changed *directories*; a change to the file shows up as
 *  a change to its parent dir. We still re-stat the file afterwards to
 *  rule out sibling-only edits — this is just the cheap pre-filter. */
export function payloadAffectsFile(
  payload: { root: string; dirs: string[] },
  root: string,
  filePath: string,
): boolean {
  if (!root || !filePath) return false;
  if (payload.root !== root) return false;
  const parent = parentDir(filePath);
  return payload.dirs.some((d) => d === parent || d === filePath);
}

export type ExternalChangeOutcome = "none" | "reload" | "flag";

/** Given the freshly-stat'd mtime, the captured baseline, and whether the
 *  buffer has unsaved edits, decide the reaction:
 *   - `none`   — not actually newer (sibling edit or our own write already
 *                baselined); do nothing.
 *   - `reload` — newer and the buffer is clean → silently reload from disk.
 *   - `flag`   — newer and the buffer is dirty → surface a reload affordance
 *                so the user chooses (reloading would drop their edits). */
export function decideExternalChange(
  mtime: number,
  baseline: number,
  isDirty: boolean,
): ExternalChangeOutcome {
  if (mtime <= baseline) return "none";
  return isDirty ? "flag" : "reload";
}
