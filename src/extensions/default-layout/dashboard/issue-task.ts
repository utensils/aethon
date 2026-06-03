import type { GhIssue, GhIssueDetail } from "../../../ghIssuesCache";
import type { IssueTemplate } from "./issue-templates";

export interface IssueTemplateProjectContext {
  id: string;
  label: string;
  path: string;
}

export interface IssueTaskPayload {
  prompt: string;
  newWorktree: boolean;
  branch?: string;
  templateId?: string;
  templateLabel?: string;
}

export function buildIssuePrompt(detail: {
  number: number;
  title: string;
  url: string;
  body: string;
  author: string | null;
}): string {
  const author = detail.author ? `@${detail.author}` : "the reporter";
  const trimmedBody = detail.body.trim();
  const bodyBlock =
    trimmedBody.length === 0 ? "_(no body provided)_" : trimmedBody;
  return [
    `Please work on GitHub issue #${detail.number}: **${detail.title}**.`,
    "",
    `Source: ${detail.url}`,
    `Reported by ${author}.`,
    "",
    "---",
    "",
    bodyBlock,
  ].join("\n");
}

const MAX_ISSUE_BRANCH_LENGTH = 44;

export function buildIssueTask(
  detail: GhIssueDetail,
  issue: GhIssue,
  project: IssueTemplateProjectContext,
  options: {
    template?: IssueTemplate | null;
    forceNewWorktree?: boolean;
    existingBranches?: ReadonlySet<string>;
  } = {},
): IssueTaskPayload {
  const existingBranches = options.existingBranches ?? new Set<string>();
  const fallbackBranch = buildIssueBranch(issue, existingBranches);
  const template = options.template ?? null;
  const newWorktree = options.forceNewWorktree ?? template?.newWorktree ?? true;
  if (!template) {
    return {
      prompt: buildIssuePrompt(detail),
      newWorktree,
      branch: newWorktree ? fallbackBranch : undefined,
    };
  }

  const vars = issueTemplateVariables(detail, issue, project, fallbackBranch);
  // Fall back to the derived prefix when an override interpolates to empty,
  // so `{branchPrefix}` can't collapse into a leading slash (e.g. `/issue-12`).
  const branchPrefix =
    (template.branchPrefix
      ? interpolateIssueTemplate(template.branchPrefix, vars).trim()
      : "") || vars.branchPrefix;
  const scopedVars = { ...vars, branchPrefix };
  const interpolatedBranch = template.branch
    ? interpolateIssueTemplate(template.branch, scopedVars).trim()
    : "";
  // Compact template-generated branches to the same ceiling as the built-in
  // path so a long {slug} can't blow past OS path limits via the worktree dir.
  const branch = interpolatedBranch
    ? compactIssueBranch(
        interpolatedBranch,
        branchPrefix.length,
        MAX_ISSUE_BRANCH_LENGTH,
      )
    : fallbackBranch;
  return {
    prompt: interpolateIssueTemplate(template.prompt, scopedVars).trim(),
    newWorktree,
    branch: newWorktree
      ? uniquifyIssueBranch(branch || fallbackBranch, existingBranches)
      : undefined,
    templateId: template.id,
    templateLabel: template.label,
  };
}

export function interpolateIssueTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key) => {
    const value = variables[String(key)];
    return value ?? "";
  });
}

export function issueTemplateVariables(
  detail: GhIssueDetail,
  issue: GhIssue,
  project: IssueTemplateProjectContext,
  branch: string = buildIssueBranch(issue),
): Record<string, string> {
  const classification = classifyIssueBranch(issue);
  const slug = slugifyIssueTitle(classification.title);
  const labels = issue.labels.map((label) => label.name).join(", ");
  return {
    number: String(detail.number),
    title: detail.title,
    url: detail.url,
    author: detail.author ? `@${detail.author}` : "",
    authorLogin: detail.author ?? "",
    body: detail.body.trim() || "_(no body provided)_",
    labels,
    comments: String(issue.comments ?? 0),
    updatedAt: issue.updatedAt ?? "",
    slug,
    branch,
    branchPrefix: classification.prefix,
    projectId: project.id,
    projectLabel: project.label,
    projectPath: project.path,
  };
}

export function buildIssueBranch(
  issue: Pick<GhIssue, "number" | "title"> & Partial<Pick<GhIssue, "labels">>,
  existingBranches: ReadonlySet<string> = new Set(),
): string {
  const { prefix, title } = classifyIssueBranch(issue);
  const slug = slugifyIssueTitle(title);
  const branchPrefix = `${prefix}/issue-${issue.number}`;
  const base = compactIssueBranch(
    `${branchPrefix}${slug ? `-${slug}` : ""}`,
    branchPrefix.length,
    MAX_ISSUE_BRANCH_LENGTH,
  );
  if (!existingBranches.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${compactIssueBranch(
      base,
      branchPrefix.length,
      MAX_ISSUE_BRANCH_LENGTH - suffix.length,
    )}${suffix}`;
    if (!existingBranches.has(candidate)) return candidate;
  }
  const suffix = `-${Date.now()}`;
  return `${compactIssueBranch(
    base,
    branchPrefix.length,
    MAX_ISSUE_BRANCH_LENGTH - suffix.length,
  )}${suffix}`;
}

function uniquifyIssueBranch(
  branch: string,
  existingBranches: ReadonlySet<string>,
): string {
  if (!existingBranches.has(branch)) return branch;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${branch}-${i}`;
    if (!existingBranches.has(candidate)) return candidate;
  }
  return `${branch}-${Date.now()}`;
}

function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compactIssueBranch(
  branch: string,
  protectedLength: number,
  maxLength: number,
): string {
  if (branch.length <= maxLength) return branch;
  const rawClipped = branch.slice(0, maxLength);
  const clipped = rawClipped.replace(/-+$/g, "");
  if (
    rawClipped.length !== clipped.length ||
    branch.charAt(maxLength) === "-"
  ) {
    return clipped;
  }
  const wordBoundary = clipped.lastIndexOf("-");
  if (wordBoundary > protectedLength) {
    return clipped.slice(0, wordBoundary).replace(/-+$/g, "");
  }
  return clipped;
}

function classifyIssueBranch(
  issue: Pick<GhIssue, "title"> & Partial<Pick<GhIssue, "labels">>,
): { prefix: string; title: string } {
  const match = issue.title.match(/^\s*([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const titleType = match?.[1].toLowerCase();
  const titleScope = match?.[2]?.trim();
  const titleRest = match?.[3]?.trim();
  const prefix =
    branchPrefixFor(titleType) ?? branchPrefixForLabels(issue.labels);
  return {
    prefix,
    title: titleRest
      ? [titleScope, titleRest].filter(Boolean).join(" ")
      : issue.title,
  };
}

function branchPrefixFor(type: string | undefined): string | null {
  switch (type) {
    case "feature":
    case "feat":
      return "feat";
    case "bug":
    case "fix":
      return "fix";
    case "doc":
    case "docs":
      return "docs";
    case "perf":
    case "refactor":
    case "test":
    case "ci":
    case "build":
    case "style":
    case "chore":
      return type;
    default:
      return null;
  }
}

function branchPrefixForLabels(labels: GhIssue["labels"] | undefined): string {
  const names = (labels ?? []).map((label) => label.name.toLowerCase());
  if (names.some((name) => /\bbug\b|defect|regression/.test(name)))
    return "fix";
  if (names.some((name) => /\bdocs?\b|documentation/.test(name))) return "docs";
  if (names.some((name) => /\bci\b|continuous[- ]integration/.test(name))) {
    return "ci";
  }
  if (names.some((name) => /\bbuild\b|packaging|release/.test(name))) {
    return "build";
  }
  if (names.some((name) => /\btests?\b|testing|coverage/.test(name))) {
    return "test";
  }
  if (names.some((name) => /\bperf\b|performance/.test(name))) return "perf";
  if (names.some((name) => /\brefactor\b|cleanup/.test(name)))
    return "refactor";
  if (names.some((name) => /\bchore\b|dependencies|maintenance/.test(name))) {
    return "chore";
  }
  if (names.some((name) => /\bfeat\b|feature|enhancement/.test(name))) {
    return "feat";
  }
  return "fix";
}
