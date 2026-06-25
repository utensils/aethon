import type { ChatMessage } from "../../types/a2ui";
import {
  toolCardDetails,
  type ToolCardFileChange,
  type ToolMessageSummary,
} from "../../utils/toolCardGrouping";

export interface ToolFileChangeEntry {
  change: ToolCardFileChange;
  componentId?: string;
}

export interface LineChangeStats {
  additions: number;
  deletions: number;
}

export function compactDuration(ms: number): string {
  if (ms <= 0) return "";
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function toolCountLabel(summary: ToolMessageSummary): string {
  const base = `${summary.total} ${summary.total === 1 ? "tool call" : "tool calls"}`;
  const states: string[] = [];
  if (summary.running > 0) states.push(`${summary.running} running`);
  if (summary.failed > 0) states.push(`${summary.failed} failed`);
  if (summary.cancelled > 0) states.push(`${summary.cancelled} cancelled`);
  return states.length > 0 ? `${base} · ${states.join(" · ")}` : base;
}

export function workedLabel(summary: ToolMessageSummary): string {
  const duration = compactDuration(summary.durationMs);
  return duration ? `Worked for ${duration}` : "Agent activity";
}

export function fileChangeLabel(summary: ToolMessageSummary): string {
  const changes = summary.fileChanges;
  if (changes.total === 0) return "";
  const verb =
    changes.created > 0 && changes.edited === 0
      ? "Created"
      : changes.edited > 0 && changes.created === 0
        ? "Edited"
        : "Changed";
  const fileText = `${changes.total} ${changes.total === 1 ? "file" : "files"}`;
  return `${verb} ${fileText}`;
}

export function activityLabel({
  summary,
  progressCount,
}: {
  summary: ToolMessageSummary;
  progressCount: number;
}): string {
  if (summary.running > 0) {
    return `${summary.running} ${summary.running === 1 ? "tool" : "tools"} running`;
  }
  const fileLabel = fileChangeLabel(summary);
  if (fileLabel) return fileLabel;
  if (summary.total > 0) return workedLabel(summary);
  return `${progressCount} ${progressCount === 1 ? "update" : "updates"}`;
}

export function activityMeta(summary: ToolMessageSummary): string {
  if (summary.fileChanges.total > 0) return "";
  return summary.total > 0 ? toolCountLabel(summary) : "";
}

export function fileChangeStatsLabel(summary: ToolMessageSummary): string {
  const parts: string[] = [];
  const label = fileChangeLabel(summary);
  if (label) parts.push(label);
  const { additions, deletions } = summary.fileChanges;
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(" ");
}

export function collectFileChangeEntries(
  messages: readonly ChatMessage[],
): ToolFileChangeEntry[] {
  const entries = new Map<string, ToolFileChangeEntry>();
  for (const message of messages) {
    const details = toolCardDetails(message);
    if (!details.fileChange?.path) continue;
    const key = statsKey(details.fileChange.rootPath, details.fileChange.path);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, {
        change: details.fileChange,
        ...(details.componentId ? { componentId: details.componentId } : {}),
      });
      continue;
    }
    const prior = existing.change;
    const priorPreview = looksLikeUnifiedDiff(prior.preview)
      ? prior.preview
      : "";
    const nextPreview = looksLikeUnifiedDiff(details.fileChange.preview)
      ? details.fileChange.preview
      : "";
    const additions =
      (prior.additions ?? 0) + (details.fileChange.additions ?? 0);
    const deletions =
      (prior.deletions ?? 0) + (details.fileChange.deletions ?? 0);
    entries.set(key, {
      change: {
        ...prior,
        kind:
          prior.kind === "created" || details.fileChange.kind === "created"
            ? "created"
            : "edited",
        rootPath: prior.rootPath ?? details.fileChange.rootPath,
        ...(priorPreview || nextPreview
          ? {
              preview: [priorPreview, nextPreview].filter(Boolean).join("\n\n"),
            }
          : {}),
        ...(additions > 0 ? { additions } : {}),
        ...(deletions > 0 ? { deletions } : {}),
      },
      componentId: details.componentId ?? existing.componentId,
    });
  }
  return Array.from(entries.values());
}

export function hasFileChange(message: ChatMessage): boolean {
  return Boolean(toolCardDetails(message).fileChange?.path);
}

export function hasToolCardChildren(message: ChatMessage): boolean {
  return Boolean(
    message.a2ui?.components?.some(
      (component) =>
        component.type === "tool-card" && (component.children?.length ?? 0) > 0,
    ),
  );
}

export function withOpenToolCards(message: ChatMessage): ChatMessage {
  if (!message.a2ui?.components?.length) return message;
  return {
    ...message,
    a2ui: {
      ...message.a2ui,
      components: message.a2ui.components.map((component) =>
        component.type === "tool-card"
          ? {
              ...component,
              props: {
                ...component.props,
                defaultOpen: true,
              },
            }
          : component,
      ),
    },
  };
}

export function basename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : "";
}

export function previewLines(preview: string): string[] {
  return preview
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .slice(0, 80);
}

export function looksLikeUnifiedDiff(
  preview: string | undefined,
): preview is string {
  if (!preview) return false;
  return /(^|\n)(diff --git |@@ |--- |\+\+\+ )/.test(preview);
}

export function effectiveStats(change: ToolCardFileChange): LineChangeStats {
  return statsFromChange(change);
}

export function summaryWithFileEntries(
  summary: ToolMessageSummary,
  entries: readonly ToolFileChangeEntry[],
): ToolMessageSummary {
  if (entries.length === 0) return summary;
  let created = 0;
  let edited = 0;
  let additions = 0;
  let deletions = 0;
  for (const { change } of entries) {
    if (change.kind === "created") created += 1;
    else edited += 1;
    const stats = effectiveStats(change);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return {
    ...summary,
    fileChanges: {
      total: entries.length,
      created,
      edited,
      additions,
      deletions,
    },
  };
}

export function lineTone(
  line: string,
): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  ) {
    return "meta";
  }
  return "ctx";
}

export function toolStateLabel(
  details: ReturnType<typeof toolCardDetails>,
): string {
  if (details.isRunning) return "Running";
  if (details.status === "cancelled") return "Cancelled";
  if (details.isError) return "Failed";
  return "Completed";
}

export function toolDurationLabel(
  details: ReturnType<typeof toolCardDetails>,
): string {
  if (details.startedAt === undefined || details.endedAt === undefined) {
    return "";
  }
  return compactDuration(Math.max(0, details.endedAt - details.startedAt));
}

function statsKey(rootPath: string | undefined, filePath: string): string {
  return `${rootPath ?? ""}\0${filePath}`;
}

function statsFromChange(change: ToolCardFileChange): LineChangeStats {
  return {
    additions: change.additions ?? 0,
    deletions: change.deletions ?? 0,
  };
}
