/**
 * Shared presentation helpers for the VCS surface — used by both the
 * header `vcs-status` cluster and the `source-control-panel`. Keeps the
 * conclusion→icon/tone mapping in one place so the two surfaces never
 * disagree on what "green" means.
 */
import type { GhCheckRun } from "../../../ghChecksCache";
import type { VcsCi, VcsChanges, VcsPr } from "../../../hooks/useVcsStatus";

export type Tone = "success" | "failure" | "pending" | "neutral" | "muted";
export type PrTone = Tone | "merged";

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

export interface CheckMeta {
  icon: string;
  label: string;
  tone: Tone;
}

/** Map a single check run to an icon + short label + tone, reusing the same
 *  glyphs/tones as `ciMeta` so the expanded list agrees with the rollup. A
 *  run is "running" until `status === "completed"`, regardless of conclusion. */
export function checkRunMeta(run: GhCheckRun): CheckMeta {
  if (run.status !== "completed") {
    return { icon: "●", label: "running", tone: "pending" };
  }
  switch (run.conclusion) {
    case "success":
      return { icon: "✓", label: "passed", tone: "success" };
    case "failure":
    case "timed_out":
    case "action_required":
      return { icon: "✕", label: "failing", tone: "failure" };
    case "cancelled":
      return { icon: "✕", label: "cancelled", tone: "neutral" };
    case "skipped":
    case "neutral":
    case "stale":
      return { icon: "–", label: "skipped", tone: "neutral" };
    default:
      return { icon: "–", label: run.conclusion ?? "unknown", tone: "neutral" };
  }
}

/** Sort priority for the expanded job list: problems first, green last. */
const CHECK_STATUS_PRIORITY: Record<Tone, number> = {
  failure: 0,
  pending: 1,
  neutral: 2,
  muted: 3,
  success: 4,
};

/** Non-mutating sort: failures → running → skipped/cancelled → passed, then
 *  alphabetical by name. Mirrors the expanded list so red surfaces at the top. */
export function sortChecks(runs: GhCheckRun[]): GhCheckRun[] {
  return [...runs].sort((a, b) => {
    const pa = CHECK_STATUS_PRIORITY[checkRunMeta(a).tone];
    const pb = CHECK_STATUS_PRIORITY[checkRunMeta(b).tone];
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

export interface PrMeta {
  label: string;
  tone: PrTone;
  title: string;
}

/** Map a PR to a short status label + tone. */
export function prMeta(pr: VcsPr | null): PrMeta | null {
  if (!pr) return null;
  const state = pr.state?.toUpperCase();
  if (pr.merged || state === "MERGED") {
    return {
      label: "merged",
      tone: "merged",
      title: `PR #${pr.number} merged`,
    };
  }
  if (state === "CLOSED") {
    return {
      label: "closed",
      tone: "failure",
      title: `PR #${pr.number} closed`,
    };
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
