/**
 * Pure mapping from `git_file_diff_hunks` output to Monaco gutter
 * decoration descriptors. Kept free of any `monaco` import so it unit
 * tests without the editor runtime; `canvas.tsx` turns these into real
 * `IModelDeltaDecoration`s (range + `linesDecorationsClassName`).
 *
 * The Rust command reports hunks in new-file coordinates: `added` /
 * `modified` span `[start, start+count-1]`; `deleted` is a single caret
 * at `start` (the line the removed text sat after).
 */

export interface DiffHunk {
  kind: "added" | "modified" | "deleted";
  start: number;
  count: number;
}

export interface GutterDecoration {
  startLine: number;
  endLine: number;
  className: string;
}

const CLASS_BY_KIND: Record<DiffHunk["kind"], string> = {
  added: "ae-git-gutter-added",
  modified: "ae-git-gutter-modified",
  deleted: "ae-git-gutter-deleted",
};

/** Clamp a hunk's line range to `[1, lineCount]` (when known) and map it
 *  to a gutter decoration. Returns null for a hunk that lands entirely
 *  outside the model (e.g. a stale deletion past the new end). */
function decorationFor(
  hunk: DiffHunk,
  lineCount: number,
): GutterDecoration | null {
  const className = CLASS_BY_KIND[hunk.kind];
  if (!className) return null;
  const max = lineCount > 0 ? lineCount : Number.MAX_SAFE_INTEGER;
  const start = Math.min(Math.max(hunk.start, 1), max);
  const rawEnd =
    hunk.kind === "deleted" ? start : hunk.start + Math.max(hunk.count, 1) - 1;
  const end = Math.min(Math.max(rawEnd, start), max);
  return { startLine: start, endLine: end, className };
}

/**
 * Map hunks to gutter decorations. `lineCount` (the model's line count)
 * clamps ranges so a decoration never points past the end of the buffer;
 * pass 0 to skip clamping.
 */
export function hunksToGutterDecorations(
  hunks: DiffHunk[] | null | undefined,
  lineCount = 0,
): GutterDecoration[] {
  if (!Array.isArray(hunks)) return [];
  const out: GutterDecoration[] = [];
  for (const hunk of hunks) {
    const dec = decorationFor(hunk, lineCount);
    if (dec) out.push(dec);
  }
  return out;
}
