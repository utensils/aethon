import { describe, expect, it } from "vitest";
import {
  diffSnapshotKey,
  isEditorDiffSnapshot,
  MAX_EDITOR_DIFF_SNAPSHOT_CHARS,
  parseUnifiedDiffSnapshot,
  truncateDiffSnapshotContent,
} from "./editorDiffSnapshot";

describe("parseUnifiedDiffSnapshot", () => {
  it("builds original and modified model text from a unified diff", () => {
    const models = parseUnifiedDiffSnapshot(
      [
        "diff --git a/src/App.tsx b/src/App.tsx",
        "--- a/src/App.tsx",
        "+++ b/src/App.tsx",
        "@@ -1,3 +1,3 @@",
        " const title =",
        "-  'Old'",
        "+  'New'",
        " export default title",
      ].join("\n"),
    );

    expect(models.original).toBe(
      "@@ -1,3 +1,3 @@\nconst title =\n  'Old'\nexport default title",
    );
    expect(models.modified).toBe(
      "@@ -1,3 +1,3 @@\nconst title =\n  'New'\nexport default title",
    );
  });
});

describe("isEditorDiffSnapshot", () => {
  it("accepts only durable tool-card unified snapshots", () => {
    const snapshot = {
      format: "unified" as const,
      content: "--- a/x\n+++ b/x\n@@\n-a\n+b",
      source: "tool-card" as const,
    };
    expect(isEditorDiffSnapshot(snapshot)).toBe(true);
    expect(diffSnapshotKey(snapshot)).toContain(snapshot.content);
    expect(isEditorDiffSnapshot({ ...snapshot, source: "git" })).toBe(false);
    expect(isEditorDiffSnapshot({ ...snapshot, additions: -1 })).toBe(false);
    expect(isEditorDiffSnapshot({ ...snapshot, deletions: 1.5 })).toBe(false);
  });
});

describe("truncateDiffSnapshotContent", () => {
  it("caps stored snapshot content to a bounded size", () => {
    const content = "x".repeat(MAX_EDITOR_DIFF_SNAPSHOT_CHARS + 10);
    const truncated = truncateDiffSnapshotContent(content);
    expect(truncated).toHaveLength(MAX_EDITOR_DIFF_SNAPSHOT_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
