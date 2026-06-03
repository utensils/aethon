/**
 * Worktree row — sibling of ItemRow, rendered as a nested child under a
 * project row when that project has worktrees attached. The visual
 * "this is a child of the project above" cue is a continuous vertical
 * guide line drawn via `.ae-worktree-row::before` in chrome.css; each
 * row contributes one segment that joins seamlessly with the next.
 * The non-main rows therefore render *no* per-row glyph — the guide
 * does the work.
 *
 * Pending worktrees (during `git worktree add` or remove) get a distinct
 * visual treatment + a small Cancel / Retry / Dismiss button cluster. Once
 * `git worktree add` resolves, the pending state clears and the row joins
 * the regular list.
 */

import { useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { AgentActivitySummary } from "../../../hooks/projectOps/agentActivity";

export interface WorktreeSidebarItem {
  id: string;
  /** User-visible label (defaults to branch name when absent). */
  label: string;
  /** Short branch name; falls back to "detached" for detached HEAD. */
  branch: string | null;
  path: string;
  active: boolean;
  isMain: boolean;
  pendingState?: "queued" | "starting" | "removing" | "succeeded" | "failed";
  pendingError?: string;
  locked?: boolean;
  /** Live agent-activity for this worktree's session scope. Only attached
   *  to non-main rows (the main worktree shares the project path, so its
   *  activity surfaces on the project line instead). */
  agent?: AgentActivitySummary;
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
  /** True when the parent sidebar has promoted this row into inline rename mode. */
  renaming?: boolean;
  /** Called after Enter/Escape/blur exits inline rename mode. */
  onRenameEnd?: (worktreeId: string) => void;
}

export function WorktreeRow({
  item,
  sectionId,
  onEvent,
  onItemContextMenu,
  renaming = false,
  onRenameEnd,
}: WorktreeRowProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameEndingRef = useRef(false);
  const renameBlurCancelRef = useRef<number | null>(null);
  const renameUnmountCancelRef = useRef<number | null>(null);
  const pending = item.pendingState;
  const isPendingActive =
    pending === "queued" || pending === "starting" || pending === "removing";
  const isFailed = pending === "failed";
  const canRenameInline = renaming && !isPendingActive && !isFailed;
  const canRemoveInline =
    !item.isMain && !isPendingActive && !isFailed && !canRenameInline;

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

  useEffect(() => {
    if (!canRenameInline) return;
    renameEndingRef.current = false;
    const focus = () => {
      if (renameBlurCancelRef.current !== null) {
        window.clearTimeout(renameBlurCancelRef.current);
        renameBlurCancelRef.current = null;
      }
      if (renameUnmountCancelRef.current !== null) {
        window.clearTimeout(renameUnmountCancelRef.current);
        renameUnmountCancelRef.current = null;
      }
      const input = renameInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.select();
    };
    focus();
    // ContextMenu restores focus to its opener on close. Re-apply focus
    // after that one-shot restore so the row editor owns typing.
    let second: number | null = null;
    const first = window.setTimeout(() => {
      second = window.setTimeout(focus, 0);
    }, 0);
    return () => {
      window.clearTimeout(first);
      if (second !== null) window.clearTimeout(second);
      if (renameBlurCancelRef.current !== null) {
        window.clearTimeout(renameBlurCancelRef.current);
        renameBlurCancelRef.current = null;
      }
      if (!renameEndingRef.current) {
        renameUnmountCancelRef.current = window.setTimeout(() => {
          renameUnmountCancelRef.current = null;
          if (renameEndingRef.current) return;
          renameEndingRef.current = true;
          onRenameEnd?.(item.id);
        }, 0);
      }
    };
  }, [canRenameInline, item.id, onRenameEnd]);

  const endRename = () => {
    if (renameBlurCancelRef.current !== null) {
      window.clearTimeout(renameBlurCancelRef.current);
      renameBlurCancelRef.current = null;
    }
    if (renameUnmountCancelRef.current !== null) {
      window.clearTimeout(renameUnmountCancelRef.current);
      renameUnmountCancelRef.current = null;
    }
    renameEndingRef.current = true;
    onRenameEnd?.(item.id);
  };
  const cancelRenameAfterBlur = () => {
    if (renameBlurCancelRef.current !== null) {
      window.clearTimeout(renameBlurCancelRef.current);
    }
    renameBlurCancelRef.current = window.setTimeout(() => {
      renameBlurCancelRef.current = null;
      if (renameEndingRef.current) return;
      if (document.activeElement === renameInputRef.current) return;
      endRename();
    }, 10);
  };
  const commitRename = (label: string) => {
    onEvent(
      "rename-worktree",
      { sectionId, itemId: item.id, worktreeId: item.id, label },
      item.id,
    );
    endRename();
  };

  return (
    <li
      className={className}
      title={tooltip}
      onMouseLeave={() => setConfirmingRemove(false)}
      onClick={() => {
        if (isPendingActive || isFailed || confirmingRemove || canRenameInline)
          return;
        onEvent("switch-worktree", { sectionId, worktreeId: item.id }, item.id);
      }}
      onDoubleClick={() => {
        if (isPendingActive || isFailed || confirmingRemove || canRenameInline)
          return;
        onEvent(
          "open-worktree-in-new-tab",
          { sectionId, worktreeId: item.id },
          item.id,
        );
      }}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {item.isMain ? (
        <span
          className="ae-worktree-glyph ae-worktree-glyph--main"
          aria-hidden="true"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      {item.agent && item.agent.status !== "none" ? (
        <span
          className={`ae-sb-agent-dot ae-sb-agent-dot--${
            item.agent.status === "running" ? "running" : "idle"
          }`}
          aria-label={
            item.agent.status === "running"
              ? "Agent running"
              : "Agent session idle"
          }
          title={
            item.agent.status === "running"
              ? `${item.agent.runningCount} agent turn${
                  item.agent.runningCount === 1 ? "" : "s"
                } running`
              : "Idle agent session — awaiting your input"
          }
        />
      ) : null}
      {canRenameInline ? (
        <input
          ref={renameInputRef}
          className="ae-worktree-rename-input"
          aria-label={`Rename worktree ${displayLabel}`}
          defaultValue={displayLabel}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commitRename(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              endRename();
            }
          }}
          onBlur={cancelRenameAfterBlur}
        />
      ) : (
        <span className="a2ui-sidebar-item-label">{displayLabel}</span>
      )}
      {!canRenameInline && item.branch && item.branch !== displayLabel ? (
        <span className="a2ui-sidebar-item-git-branch ae-worktree-branch">
          {item.branch}
        </span>
      ) : null}
      {isPendingActive ? (
        <span className="ae-worktree-pending-status">
          {pending === "queued"
            ? "queued…"
            : pending === "removing"
              ? "removing…"
              : "creating…"}
          {pending !== "removing" ? (
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
          ) : null}
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
