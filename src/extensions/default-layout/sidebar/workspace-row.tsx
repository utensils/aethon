/**
 * Workspace row — sibling of ItemRow, rendered as a nested child under a
 * project row when that project has workspaces attached. The visual
 * "this is a child of the project above" cue is a continuous vertical
 * guide line drawn via `.ae-workspace-row::before` in chrome.css; each
 * row contributes one segment that joins seamlessly with the next.
 * Each normal row still reserves a small agent-status marker next to
 * the label so session state does not pop in only after a workspace is
 * selected. The guide communicates hierarchy; the marker communicates
 * session/activity state.
 *
 * Pending workspaces (during `git worktree add` or remove) get a distinct
 * visual treatment + a small Cancel / Retry / Dismiss button cluster. Once
 * `git worktree add` resolves, the pending state clears and the row joins
 * the regular list.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { AgentActivitySummary } from "../../../hooks/projectOps/agentActivity";
import { getGhBranchStatus } from "../../../ghBranchStatusCache";
import { getGhChecks } from "../../../ghChecksCache";
import { gitWorktrees } from "../../../workspaces";
import {
  summarizeWorkspacePrStatus,
  type WorkspacePrChip,
} from "./workspace-pr-status";

export const WORKSPACE_PR_REFRESH_MS = 60_000;
export const WORKSPACE_PENDING_CI_REFRESH_MS = 45_000;

async function liveBranchStillMatches(
  path: string,
  branch: string,
  hostId?: string | null,
): Promise<boolean> {
  try {
    const live = hostId
      ? await gitWorktrees(path, hostId)
      : await gitWorktrees(path);
    const row = live.find((w) => w.path === path);
    if (!row) return true;
    return row.branch === branch;
  } catch {
    return true;
  }
}

export interface WorkspaceSidebarItem {
  id: string;
  projectId?: string;
  hostId?: string;
  remoteId?: string;
  remoteProjectId?: string;
  /** User-visible label (defaults to branch name when absent). */
  label: string;
  /** Short branch name; falls back to "detached" for detached HEAD. */
  branch: string | null;
  path: string;
  createdAt?: number;
  active: boolean;
  isMain: boolean;
  pendingState?: "queued" | "starting" | "removing" | "succeeded" | "failed";
  pendingError?: string;
  locked?: boolean;
  /** Live agent-activity for this workspace's session scope. */
  agent?: AgentActivitySummary;
}

export interface WorkspaceRowProps {
  item: WorkspaceSidebarItem;
  sectionId: string;
  onEvent: BuiltinComponentProps["onEvent"];
  onItemContextMenu?: (
    e: React.MouseEvent<HTMLElement>,
    item: WorkspaceSidebarItem,
    sectionId: string,
  ) => void;
  /** True when the parent sidebar has promoted this row into inline rename mode. */
  renaming?: boolean;
  /** Called after Enter/Escape/blur exits inline rename mode. */
  onRenameEnd?: (workspaceId: string) => void;
  dragging?: boolean;
  dropSide?: "before" | "after";
  dragOffsetY?: number;
  onPointerDragStart?: (
    e: React.PointerEvent<HTMLElement>,
    item: WorkspaceSidebarItem,
  ) => void;
  consumeSuppressedClick?: () => boolean;
}

function isRemoteWorkspaceItem(item: WorkspaceSidebarItem): boolean {
  return (
    typeof item.remoteId === "string" ||
    typeof item.remoteProjectId === "string" ||
    (typeof item.hostId === "string" && item.hostId.startsWith("remote:"))
  );
}

export function WorkspaceRow({
  item,
  sectionId,
  onEvent,
  onItemContextMenu,
  renaming = false,
  onRenameEnd,
  dragging = false,
  dropSide,
  dragOffsetY = 0,
  onPointerDragStart,
  consumeSuppressedClick,
}: WorkspaceRowProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [prChip, setPrChip] = useState<WorkspacePrChip | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameEndingRef = useRef(false);
  const renameBlurCancelRef = useRef<number | null>(null);
  const renameUnmountCancelRef = useRef<number | null>(null);
  const pending = item.pendingState;
  const isPendingActive =
    pending === "queued" || pending === "starting" || pending === "removing";
  const isFailed = pending === "failed";
  const agentRunning = item.agent?.status === "running";
  const canRenameInline = renaming && !isPendingActive && !isFailed;
  const isRemote = isRemoteWorkspaceItem(item);
  const canRemoveInline =
    !isRemote &&
    !item.isMain &&
    !isPendingActive &&
    !isFailed &&
    !canRenameInline;
  const prEligible =
    !item.isMain && !isPendingActive && !isFailed && item.branch != null;

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let loadedOnce = false;
    let refreshTimer: number | null = null;
    const branch = item.branch;
    if (!prEligible || !branch) {
      return;
    }

    const clearRefreshTimer = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };

    const scheduleRefresh = (chip: WorkspacePrChip | null) => {
      clearRefreshTimer();
      const delay =
        chip?.ci === "pending"
          ? WORKSPACE_PENDING_CI_REFRESH_MS
          : WORKSPACE_PR_REFRESH_MS;
      refreshTimer = window.setTimeout(() => {
        void load();
      }, delay);
    };

    const load = async () => {
      if (cancelled || polling || document.hidden) return;
      const showLoading = !loadedOnce;
      polling = true;
      if (showLoading) {
        setPrLoading(true);
        setPrChip(null);
      }
      try {
        if (!(await liveBranchStillMatches(item.path, branch, item.hostId))) {
          if (!cancelled) {
            loadedOnce = true;
            setPrChip(null);
            scheduleRefresh(null);
          }
          return;
        }
        const status = item.hostId
          ? await getGhBranchStatus(item.path, branch, item.hostId)
          : await getGhBranchStatus(item.path, branch);
        const checks =
          status.ghAvailable &&
          status.repo &&
          !status.workspaceBroken &&
          status.prs.length > 0
            ? await (
                item.hostId
                  ? getGhChecks(item.path, branch, item.hostId)
                  : getGhChecks(item.path, branch)
              ).catch(() => null)
            : null;
        if (!cancelled) {
          const chip = summarizeWorkspacePrStatus(status, checks);
          loadedOnce = true;
          setPrChip(chip);
          scheduleRefresh(chip);
        }
      } catch {
        if (!cancelled) {
          loadedOnce = true;
          setPrChip(null);
          scheduleRefresh(null);
        }
      } finally {
        polling = false;
        if (!cancelled && showLoading) setPrLoading(false);
      }
    };

    const onFocus = () => {
      if (!document.hidden) void load();
    };
    const onVisibility = () => {
      if (!document.hidden) void load();
    };

    void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearRefreshTimer();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [item.branch, item.hostId, item.path, prEligible]);

  const className = [
    "a2ui-sidebar-item",
    "ae-workspace-row",
    item.active ? "a2ui-sidebar-item-active" : "",
    item.isMain ? "ae-workspace-row--main" : "",
    isPendingActive ? "ae-workspace-row--pending" : "",
    isFailed ? "ae-workspace-row--failed" : "",
    dragging ? "ae-workspace-row--dragging" : "",
    dropSide ? `ae-workspace-row-drop-${dropSide}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const tooltip = isFailed && item.pendingError ? item.pendingError : item.path;
  const displayLabel = item.label || item.branch || "workspace";
  const agentStatus = item.agent?.status ?? "none";
  const agentVisualState =
    agentStatus === "running"
      ? "running"
      : agentStatus === "needs-attention"
        ? "attention"
        : agentStatus === "idle-with-session"
          ? "idle"
          : "dormant";
  const showAgentStatusMarker = !isPendingActive && !isFailed;
  const agentStatusLabel =
    agentStatus === "running"
      ? "Agent running"
      : agentStatus === "needs-attention"
        ? "Agent ready for your reply"
        : agentStatus === "idle-with-session"
          ? "Agent session idle"
          : "No agent session";
  const agentStatusTitle =
    agentStatus === "running"
      ? `${item.agent?.runningCount ?? 1} agent turn${
          (item.agent?.runningCount ?? 1) === 1 ? "" : "s"
        } running`
      : agentStatus === "needs-attention"
        ? "Agent finished — ready for your reply"
        : agentStatus === "idle-with-session"
          ? "Idle agent session — awaiting your input"
          : "No agent session yet";

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
      "rename-workspace",
      { sectionId, itemId: item.id, workspaceId: item.id, label },
      item.id,
    );
    endRename();
  };

  return (
    <li
      className={className}
      data-workspace-id={item.id}
      data-project-id={item.projectId}
      title={tooltip}
      draggable={false}
      style={
        dragging
          ? ({ "--ae-workspace-drag-y": `${dragOffsetY}px` } as CSSProperties)
          : undefined
      }
      onPointerDown={(e) => onPointerDragStart?.(e, item)}
      onMouseLeave={() => setConfirmingRemove(false)}
      onClick={() => {
        if (consumeSuppressedClick?.()) return;
        if (isPendingActive || isFailed || confirmingRemove || canRenameInline)
          return;
        onEvent(
          "switch-workspace",
          {
            sectionId,
            workspaceId: item.id,
            projectId: item.projectId,
            hostId: item.hostId,
            remoteId: item.remoteId,
            remoteProjectId: item.remoteProjectId,
          },
          item.id,
        );
      }}
      onDoubleClick={() => {
        if (consumeSuppressedClick?.()) return;
        if (isPendingActive || isFailed || confirmingRemove || canRenameInline)
          return;
        onEvent(
          "open-workspace-in-new-tab",
          {
            sectionId,
            workspaceId: item.id,
            projectId: item.projectId,
            hostId: item.hostId,
            remoteId: item.remoteId,
            remoteProjectId: item.remoteProjectId,
          },
          item.id,
        );
      }}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {item.isMain ? (
        <span
          className="ae-workspace-glyph ae-workspace-glyph--main"
          aria-hidden="true"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      {showAgentStatusMarker ? (
        <span
          className={`ae-sb-agent-dot ae-sb-agent-dot--${agentVisualState}`}
          aria-label={agentStatusLabel}
          title={agentStatusTitle}
        />
      ) : null}
      {canRenameInline ? (
        <input
          ref={renameInputRef}
          className="ae-workspace-rename-input"
          aria-label={`Rename workspace ${displayLabel}`}
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
        <span className="a2ui-sidebar-item-git-branch ae-workspace-branch">
          {item.branch}
        </span>
      ) : null}
      {prEligible && !canRenameInline && (prLoading || prChip) ? (
        <span className="ae-workspace-pr-slot">
          {prChip ? (
            <WorkspacePrBadge chip={prChip} />
          ) : (
            <span aria-hidden="true" />
          )}
        </span>
      ) : null}
      {isPendingActive ? (
        <span className="ae-workspace-pending-status">
          {pending === "queued"
            ? "queued…"
            : pending === "removing"
              ? "removing…"
              : "creating…"}
          {pending !== "removing" ? (
            <button
              type="button"
              className="ae-workspace-action"
              onClick={(e) => {
                e.stopPropagation();
                onEvent(
                  "cancel-pending-workspace",
                  { sectionId, workspaceId: item.id },
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
        <span className="ae-workspace-pending-status ae-workspace-pending-failed">
          failed
          <button
            type="button"
            className="ae-workspace-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "retry-pending-workspace",
                { sectionId, workspaceId: item.id },
                item.id,
              );
            }}
          >
            retry
          </button>
          <button
            type="button"
            className="ae-workspace-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "cancel-pending-workspace",
                { sectionId, workspaceId: item.id },
                item.id,
              );
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </span>
      ) : null}
      {!isPendingActive && !isFailed && agentRunning ? (
        <span className="ae-workspace-pending-status">
          <button
            type="button"
            className="ae-workspace-action"
            onClick={(e) => {
              e.stopPropagation();
              onEvent(
                "stop-workspace-agent",
                { sectionId, workspaceId: item.id },
                item.id,
              );
            }}
            aria-label="Stop agent"
            title="Stop the running agent turn"
          >
            stop
          </button>
        </span>
      ) : null}
      {item.locked ? (
        <span
          className="ae-workspace-lock"
          aria-label="Locked"
          title="Workspace is locked"
        >
          ◆
        </span>
      ) : null}
      {canRemoveInline ? (
        <span className="ae-workspace-remove-slot">
          {confirmingRemove ? (
            <button
              type="button"
              className="ae-workspace-confirm-remove"
              aria-label={`Confirm remove ${displayLabel}`}
              onClick={(e) => {
                e.stopPropagation();
                onEvent(
                  "remove-workspace",
                  { sectionId, workspaceId: item.id, confirmed: true },
                  item.id,
                );
              }}
            >
              Confirm
            </button>
          ) : (
            <button
              type="button"
              className="ae-workspace-remove"
              aria-label={`Remove ${displayLabel}`}
              title="Remove workspace"
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

function WorkspacePrBadge({ chip }: { chip: WorkspacePrChip }) {
  const content = (
    <>
      {chip.ci ? (
        <span
          className={`ae-workspace-pr-ci ae-workspace-pr-ci--${chip.ci}`}
          aria-hidden="true"
        />
      ) : null}
      <span className="ae-workspace-pr-label">{chip.label}</span>
    </>
  );
  const className = `ae-workspace-pr-chip ae-workspace-pr-chip--${chip.kind}`;
  if (chip.url) {
    const url = chip.url;
    return (
      <a
        className={className}
        href={url}
        title={chip.title}
        aria-label={chip.title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.detail > 1) return;
          void openUrl(url).catch(() => undefined);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {content}
      </a>
    );
  }
  return (
    <span className={className} title={chip.title} aria-label={chip.title}>
      {content}
    </span>
  );
}
