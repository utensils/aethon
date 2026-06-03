import { invoke } from "@tauri-apps/api/core";
import type { GhIssue } from "../../../ghIssuesCache";

export interface IssueTemplate {
  id: string;
  label: string;
  prompt: string;
  newWorktree: boolean | null;
  branch: string | null;
  branchPrefix: string | null;
  whenLabels: string[];
}

export interface IssueTemplatesConfig {
  templates: IssueTemplate[];
  warning: string | null;
}

const EMPTY_CONFIG: IssueTemplatesConfig = { templates: [], warning: null };

export async function loadIssueTemplates(
  projectPath: string,
): Promise<IssueTemplatesConfig> {
  try {
    const raw = await invoke<unknown>("read_issue_templates", { projectPath });
    return normalizeIssueTemplatesConfig(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      templates: [],
      warning: `Could not read .aethon/issues.toml; using built-in issue prompt. ${message}`,
    };
  }
}

export function normalizeIssueTemplatesConfig(
  raw: unknown,
): IssueTemplatesConfig {
  if (!raw || typeof raw !== "object") return EMPTY_CONFIG;
  const obj = raw as { templates?: unknown; warning?: unknown };
  const templates = Array.isArray(obj.templates)
    ? obj.templates.flatMap(normalizeIssueTemplate)
    : [];
  const warning =
    typeof obj.warning === "string" && obj.warning.trim().length > 0
      ? obj.warning
      : null;
  return { templates, warning };
}

function normalizeIssueTemplate(raw: unknown): IssueTemplate[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  if (!id || !prompt.trim()) return [];
  const label =
    typeof obj.label === "string" && obj.label.trim().length > 0
      ? obj.label.trim()
      : id;
  return [
    {
      id,
      label,
      prompt,
      newWorktree:
        typeof obj.newWorktree === "boolean" ? obj.newWorktree : null,
      branch: typeof obj.branch === "string" ? obj.branch : null,
      branchPrefix:
        typeof obj.branchPrefix === "string" && obj.branchPrefix.trim().length > 0
          ? obj.branchPrefix.trim()
          : null,
      whenLabels: Array.isArray(obj.whenLabels)
        ? obj.whenLabels.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
        : [],
    },
  ];
}

export function matchingIssueTemplates(
  templates: readonly IssueTemplate[],
  issue: Pick<GhIssue, "labels">,
): IssueTemplate[] {
  if (templates.length === 0) return [];
  const issueLabels = new Set(
    issue.labels.map((label) => label.name.trim().toLowerCase()),
  );
  const specific: IssueTemplate[] = [];
  const catchAll: IssueTemplate[] = [];
  for (const template of templates) {
    if (template.whenLabels.length === 0) {
      catchAll.push(template);
      continue;
    }
    if (
      template.whenLabels.some((label) =>
        issueLabels.has(label.trim().toLowerCase()),
      )
    ) {
      specific.push(template);
    }
  }
  return [...specific, ...catchAll];
}
