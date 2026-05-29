/**
 * Shared presentation helpers for the VCS surface — used by both the
 * header `vcs-status` cluster and the `source-control-panel`. Keeps the
 * conclusion→icon/tone mapping in one place so the two surfaces never
 * disagree on what "green" means.
 */
import type { VcsCi, VcsChanges, VcsPr } from "../../../hooks/useVcsStatus";

export type Tone = "success" | "failure" | "pending" | "neutral" | "muted";

export interface CiMeta {
  icon: string;
  label: string;
  tone: Tone;
  title: string;
}

/** Map a CI rollup to an icon + short label + tone. */
export function ciMeta(ci: VcsCi | null): CiMeta | null {
  if (!ci || !ci.conclusion) return null;
  switch (ci.conclusion) {
    case "success":
      return {
        icon: "✓",
        label: "checks pass",
        tone: "success",
        title: `${ci.passed}/${ci.total} checks passed`,
      };
    case "failure":
      return {
        icon: "✕",
        label: ci.failed > 1 ? `${ci.failed} failing` : "check failing",
        tone: "failure",
        title: `${ci.failed} of ${ci.total} checks failing`,
      };
    case "pending":
      return {
        icon: "●",
        label: "checks running",
        tone: "pending",
        title: `${ci.pending} of ${ci.total} checks running`,
      };
    case "neutral":
      return {
        icon: "–",
        label: "checks neutral",
        tone: "neutral",
        title: `${ci.total} checks (no pass/fail)`,
      };
    default:
      return null;
  }
}

export interface PrMeta {
  label: string;
  tone: Tone;
  title: string;
}

/** Map a PR to a short status label + tone. */
export function prMeta(pr: VcsPr | null): PrMeta | null {
  if (!pr) return null;
  const state = pr.state?.toUpperCase();
  if (pr.merged || state === "MERGED") {
    return { label: "merged", tone: "neutral", title: `PR #${pr.number} merged` };
  }
  if (state === "CLOSED") {
    return { label: "closed", tone: "failure", title: `PR #${pr.number} closed` };
  }
  if (pr.isDraft) {
    return { label: "draft", tone: "muted", title: `PR #${pr.number} (draft)` };
  }
  return { label: "open", tone: "success", title: `PR #${pr.number} open` };
}

/** "12M 3A 1D 2U" style breakdown, omitting zero buckets. */
export function changeBreakdown(c: VcsChanges): string {
  const parts: string[] = [];
  if (c.modified) parts.push(`${c.modified}M`);
  if (c.added) parts.push(`${c.added}A`);
  if (c.deleted) parts.push(`${c.deleted}D`);
  if (c.renamed) parts.push(`${c.renamed}R`);
  if (c.copied) parts.push(`${c.copied}C`);
  if (c.untracked) parts.push(`${c.untracked}U`);
  if (c.conflicted) parts.push(`${c.conflicted}!`);
  return parts.join(" ");
}
