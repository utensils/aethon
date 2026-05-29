import { describe, expect, it } from "vitest";
import { hunksToGutterDecorations } from "./git-gutter";

describe("hunksToGutterDecorations", () => {
  it("maps each kind to its gutter class with the right span", () => {
    expect(
      hunksToGutterDecorations([
        { kind: "added", start: 5, count: 2 },
        { kind: "modified", start: 10, count: 1 },
        { kind: "deleted", start: 20, count: 1 },
      ]),
    ).toEqual([
      { startLine: 5, endLine: 6, className: "ae-git-gutter-added" },
      { startLine: 10, endLine: 10, className: "ae-git-gutter-modified" },
      { startLine: 20, endLine: 20, className: "ae-git-gutter-deleted" },
    ]);
  });

  it("clamps ranges to the model line count when provided", () => {
    // A stale deletion caret past EOF clamps back onto the last line.
    expect(hunksToGutterDecorations([{ kind: "deleted", start: 999, count: 1 }], 12)).toEqual([
      { startLine: 12, endLine: 12, className: "ae-git-gutter-deleted" },
    ]);
    // An added run partly past EOF clamps its end.
    expect(hunksToGutterDecorations([{ kind: "added", start: 10, count: 10 }], 12)).toEqual([
      { startLine: 10, endLine: 12, className: "ae-git-gutter-added" },
    ]);
  });

  it("tolerates empty / non-array input", () => {
    expect(hunksToGutterDecorations([])).toEqual([]);
    expect(hunksToGutterDecorations(null)).toEqual([]);
    expect(hunksToGutterDecorations(undefined)).toEqual([]);
  });
});
