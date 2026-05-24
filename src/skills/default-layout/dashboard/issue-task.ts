import type { GhIssue } from "../../../ghIssuesCache";

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

export function buildIssueBranch(
  issue: Pick<GhIssue, "number" | "title"> & Partial<Pick<GhIssue, "labels">>,
  existingBranches: ReadonlySet<string> = new Set(),
): string {
  const { prefix, title } = classifyIssueBranch(issue);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const base = `${prefix}/issue-${issue.number}${slug ? `-${slug}` : ""}`;
  if (!existingBranches.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existingBranches.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
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
