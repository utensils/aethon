/**
 * Worktree row — sibling of ItemRow, rendered as a nested child under a
 * project row when that project has worktrees attached. The visual
 * "this is a child of the project above" cue is a continuous vertical
 * guide line drawn via `.ae-worktree-row::before` in chrome.css; each
 * row contributes one segment that joins seamlessly with the next.
 * The non-main rows therefore render *no* per-row glyph — the guide
 * does the work.
 *
 * Pending worktrees (during `git worktree add`) get a distinct visual
 * treatment + a small Cancel / Retry / Dismiss button cluster. Once
 * `git worktree add` resolves, the pending state clears and the row
 * joins the regular list.
 */

import { useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

export interface WorktreeSidebarItem {
  id: string;
  /** User-visible label (defaults to branch name when absent). */
  label: string;
  /** Short branch name; falls back to "detached" for detached HEAD. */
  branch: string | null;
  path: string;
  active: boolean;
  isMain: boolean;
  pendingState?: "queued" | "starting" | "succeeded" | "failed";
  pendingError?: string;
  locked?: boolean;
}

export interface WorktreeRowProps {
  item: WorktreeSidebarItem;
  sectionId: string;
  onEvent: BuiltinComponentProps["onEvent"];
  onItemContextMenu?: (
    e: React.MouseEvent<HTMLElement>,
    item: WorktreeSidebarItem,
    sectionId: string,
  ) => void;
}

export function WorktreeRow({
  item,
  sectionId,
  onEvent,
  onItemContextMenu,
}: WorktreeRowProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const pending = item.pendingState;
  const isPendingActive = pending === "queued" || pending === "starting";
  const isFailed = pending === "failed";
  const canRemoveInline = !item.isMain && !isPendingActive && !isFailed;

  const className = [
    "a2ui-sidebar-item",
    "ae-worktree-row",
    item.active ? "a2ui-sidebar-item-active" : "",
    item.isMain ? "ae-worktree-row--main" : "",
    isPendingActive ? "ae-worktree-row--pending" : "",
    isFailed ? "ae-worktree-row--failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const tooltip = isFailed && item.pendingError ? item.pendingError : item.path;
  const displayLabel = item.label || item.branch || "worktree";

  return (
    <li
      className={className}
      title={tooltip}
      onMouseLeave={() => setConfirmingRemove(false)}
      onClick={() => {
        if (isPendingActive || isFailed || confirmingRemove) return;
        onEvent("switch-worktree", { sectionId, worktreeId: item.id }, item.id);
      }}
      onDoubleClick={() => {
        if (isPendingActive || isFailed || confirmingRemove) return;
        onEvent(
          "open-worktree-in-new-tab",
          { sectionId, worktreeId: item.id },
          item.id,
        );
      }}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {item.isMain ? (
        <span className="ae-worktree-glyph ae-worktree-glyph--main" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      <span className="a2ui-sidebar-item-label">{displayLabel}</span>
      {item.branch && item.branch !== displayLabel ? (
        <span className="a2ui-sidebar-item-git-branch ae-worktree-branch">
          {item.branch}
        </span>
      ) : null}
      {isPendingActive ? (
        <span className="ae-worktree-pending-status">
          {pending === "queued" ? "queued…" : "creating…"}
          <button
            type="button"
            className="ae-worktree-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "cancel-pending-worktree",
                { sectionId, worktreeId: item.id },
                item.id,
              );
            }}
            aria-label="Cancel"
          >
            ×
          </button>
        </span>
      ) : null}
      {isFailed ? (
        <span className="ae-worktree-pending-status ae-worktree-pending-failed">
          failed
          <button
            type="button"
            className="ae-worktree-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "retry-pending-worktree",
                { sectionId, worktreeId: item.id },
                item.id,
              );
            }}
          >
            retry
          </button>
          <button
            type="button"
            className="ae-worktree-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "cancel-pending-worktree",
                { sectionId, worktreeId: item.id },
                item.id,
              );
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </span>
      ) : null}
      {item.locked ? (
        <span
          className="ae-worktree-lock"
          aria-label="Locked"
          title="Worktree is locked"
        >
          ◆
        </span>
      ) : null}
      {canRemoveInline ? (
        <span className="ae-worktree-remove-slot">
          {confirmingRemove ? (
            <button
              type="button"
              className="ae-worktree-confirm-remove"
              aria-label={`Confirm remove ${displayLabel}`}
              onClick={(e) => {
                e.stopPropagation();
                onEvent(
                  "remove-worktree",
                  { sectionId, worktreeId: item.id, confirmed: true },
                  item.id,
                );
              }}
            >
              Confirm
            </button>
          ) : (
            <button
              type="button"
              className="ae-worktree-remove"
              aria-label={`Remove ${displayLabel}`}
              title="Remove worktree"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingRemove(true);
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M5.5 2.75h5M6.25 2.75l.5-1h2.5l.5 1M3.5 4.5h9M5 4.5l.55 9h4.9l.55-9M7 6.5v5M9 6.5v5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.35"
                />
              </svg>
            </button>
          )}
        </span>
      ) : null}
    </li>
  );
}
