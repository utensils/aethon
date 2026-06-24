import type { EditorDiffSnapshot } from "../types/tab";

export interface DiffSnapshotModels {
  original: string;
  modified: string;
}

export const MAX_EDITOR_DIFF_SNAPSHOT_CHARS = 64 * 1024;

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

export function truncateDiffSnapshotContent(content: string): string {
  if (content.length <= MAX_EDITOR_DIFF_SNAPSHOT_CHARS) return content;
  return `${content.slice(0, MAX_EDITOR_DIFF_SNAPSHOT_CHARS - 1)}…`;
}

export function isEditorDiffSnapshot(
  value: unknown,
): value is EditorDiffSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<EditorDiffSnapshot>;
  return (
    snapshot.format === "unified" &&
    typeof snapshot.content === "string" &&
    snapshot.content.length > 0 &&
    snapshot.source === "tool-card" &&
    (snapshot.additions === undefined ||
      isNonNegativeInteger(snapshot.additions)) &&
    (snapshot.deletions === undefined ||
      isNonNegativeInteger(snapshot.deletions))
  );
}

export function diffSnapshotKey(
  snapshot: EditorDiffSnapshot | undefined,
): string {
  if (!snapshot) return "";
  return [
    snapshot.format,
    snapshot.source,
    snapshot.additions ?? "",
    snapshot.deletions ?? "",
    snapshot.content,
  ].join("\0");
}

export function parseUnifiedDiffSnapshot(
  content: string,
): DiffSnapshotModels {
  const original: string[] = [];
  const modified: string[] = [];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      original.push(line);
      modified.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      modified.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      original.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      const text = line.slice(1);
      original.push(text);
      modified.push(text);
      continue;
    }
    original.push(line);
    modified.push(line);
  }
  if (original.length === 0 && modified.length === 0 && content) {
    return { original: "", modified: content };
  }
  return {
    original: original.join("\n"),
    modified: modified.join("\n"),
  };
}
