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
  issue: Pick<GhIssue, "number" | "title">,
  existingBranches: ReadonlySet<string> = new Set(),
): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const base = `fix/issue-${issue.number}${slug ? `-${slug}` : ""}`;
  if (!existingBranches.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existingBranches.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
