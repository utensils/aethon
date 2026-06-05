import type { GhBranchStatus, GhPr } from "../../../ghBranchStatusCache";
import type { GhChecks } from "../../../ghChecksCache";

export type WorktreePrKind = "open" | "draft" | "merged" | "closed" | "stale";
export type WorktreeCiKind = "success" | "failure" | "pending" | "neutral";

export interface WorktreePrChip {
  kind: WorktreePrKind;
  label: string;
  title: string;
  url?: string;
  ci?: WorktreeCiKind;
}

function pickPr(prs: GhPr[]): GhPr | null {
  if (!prs || prs.length === 0) return null;
  return prs.find((p) => p.state?.toUpperCase() === "OPEN") ?? prs[0];
}

function ciKind(checks: GhChecks | null | undefined): WorktreeCiKind | undefined {
  if (!checks?.ghAvailable || !checks.conclusion || checks.conclusion === "none") {
    return undefined;
  }
  if (
    checks.conclusion === "success" ||
    checks.conclusion === "failure" ||
    checks.conclusion === "pending" ||
    checks.conclusion === "neutral"
  ) {
    return checks.conclusion;
  }
  return undefined;
}

export function summarizeWorktreePrStatus(
  status: GhBranchStatus | null | undefined,
  checks?: GhChecks | null,
): WorktreePrChip | null {
  if (!status) return null;
  if (status.worktreeBroken) {
    return {
      kind: "stale",
      label: "stale",
      title: "Worktree metadata is stale. Git no longer tracks this checkout.",
    };
  }
  if (!status.ghAvailable || !status.repo) return null;
  const pr = pickPr(status.prs);
  if (!pr) return null;

  const open = pr.state?.toUpperCase() === "OPEN";
  const kind: WorktreePrKind = pr.merged
    ? "merged"
    : pr.isDraft && open
      ? "draft"
      : open
        ? "open"
        : "closed";
  const label =
    kind === "draft"
      ? `draft #${pr.number}`
      : kind === "merged"
        ? `merged #${pr.number}`
        : kind === "closed"
          ? `closed #${pr.number}`
          : `#${pr.number}`;
  const stateLabel =
    kind === "open"
      ? "Open"
      : kind === "draft"
        ? "Draft"
        : kind === "merged"
          ? "Merged"
          : "Closed";
  const ci = ciKind(checks);
  const titleParts = [
    `${stateLabel} PR #${pr.number}: ${pr.title || "Untitled"}`,
    pr.baseRefName ? `base ${pr.baseRefName}` : "",
    ci ? `CI ${ci}` : "",
  ].filter(Boolean);

  return {
    kind,
    label,
    title: titleParts.join(" / "),
    url: pr.url || undefined,
    ci,
  };
}
