import type { ReactNode } from "react";
import type { A2UIComponent, SidebarItem } from "../../../types/a2ui";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { Chevron } from "./chevron";

export interface ItemRowProps {
  item: SidebarItem;
  monoItems: boolean;
  sectionId: string;
  componentId: string;
  onEvent: BuiltinComponentProps["onEvent"];
  onItemContextMenu?: (
    e: React.MouseEvent<HTMLElement>,
    item: SidebarItem,
    sectionId: string,
  ) => void;
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
  state: BuiltinComponentProps["state"];
  index: number;
  /** When set, render a disclosure caret in front of the label so the
   *  caller can show / hide nested rows below this one. The caret reflects
   *  the current state; the row itself stays clickable for "select". */
  disclosure?: "expanded" | "collapsed";
  /** Click handler for the disclosure caret only; toggles independent of
   *  row selection so the user can expand without switching projects. */
  onToggleDisclosure?: () => void;
  /** Reserve the same horizontal space for the disclosure chevron and
   *  the git dirty-dot whether or not this row actually has them.
   *  Projects section sets this so a repo without workspaces aligns its
   *  label at the same x-coordinate as a sibling project with workspaces.
   *  Other sections (panels, history) leave it off so they stay tight. */
  alignSlots?: boolean;
  /** Render as a two-line card: the label on line 1, a git meta line
   *  (branch · dirty · ahead/behind) on line 2. Set for project rows so
   *  the branch never squeezes the project name onto a single line.
   *  Other sections stay single-line. */
  stacked?: boolean;
  /** Optional trailing control rendered after the hint (e.g. a toggle
   *  switch for extension rows). Click propagation is the caller's
   *  responsibility — `ToggleSwitch` already stops propagation so the
   *  outer row's "select" click doesn't fire on toggle activation. */
  trailingControl?: ReactNode;
}

function selectPayload(sectionId: string, item: SidebarItem): Record<string, unknown> {
  const base = { sectionId, itemId: item.id };
  if (sectionId !== "mobile-devices") return base;
  return {
    ...base,
    label: item.label,
    platform: item.platform,
    status: item.hint,
    paired: item.paired,
    connected: item.connected,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
  };
}

export function ItemRow({
  item,
  monoItems,
  sectionId,
  componentId,
  onEvent,
  onItemContextMenu,
  renderChildWithState,
  state,
  index,
  disclosure,
  onToggleDisclosure,
  alignSlots,
  stacked,
  trailingControl,
}: ItemRowProps) {
  if (item.componentType && renderChildWithState) {
    const synthetic: A2UIComponent = {
      id: `${componentId}__sec_${sectionId}__item_${item.id}`,
      type: item.componentType,
    };
    return (
      <li
        className="a2ui-sidebar-item a2ui-sidebar-item-custom"
        onClick={() =>
          onEvent("select", selectPayload(sectionId, item), item.id)
        }
        onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
      >
        {renderChildWithState(synthetic, {
          $item: item,
          $index: index,
          $parent: state,
        })}
      </li>
    );
  }
  const hint = (item as { hint?: string }).hint;
  // Native tooltip — full path / long form. Layouts can set this on
  // any sidebar item; the projects section uses it for the absolute
  // path so the row label stays compact (basename only).
  const tooltip = (item as { tooltip?: string }).tooltip;
  // Per-item git badge — { branch?, dirty?, ahead?, behind? }.
  // Drives a small chip + dirty dot before the hint.
  const git = (
    item as {
      git?: {
        branch?: string;
        dirty?: boolean;
        ahead?: number;
        behind?: number;
      };
    }
  ).git;
  const branchTitle = git?.branch
    ? `Branch: ${git.branch}${git.dirty ? " (uncommitted changes)" : ""}`
    : undefined;
  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;

  // Agent-activity dot — leading status indicator distinct from the trailing
  // git dirty dot. A running workspace turn should keep the project line
  // visibly active even while the project is expanded and another workspace
  // is selected. Idle workspace-only sessions stay on their own rows while
  // expanded to avoid duplicate idle rings; collapsed projects fall back to
  // the rollup because their workspace rows are hidden.
  const agentRaw = item as {
    agent?: { status?: string; runningCount?: number };
    agentRollup?: { status?: string; runningCount?: number };
  };
  const ownAgent = agentRaw.agent;
  const rollupAgent = agentRaw.agentRollup;
  const agent =
    rollupAgent?.status === "running"
      ? rollupAgent
      : rollupAgent?.status === "needs-attention"
        ? rollupAgent
        : disclosure === "collapsed"
          ? (rollupAgent ?? ownAgent)
          : ownAgent;
  const agentVisualState =
    agent?.status === "running"
      ? "running"
      : agent?.status === "needs-attention"
        ? "attention"
        : "idle";
  const agentDotEl =
    agent && agent.status && agent.status !== "none" ? (
      <span
        className={`ae-sb-agent-dot ae-sb-agent-dot--${agentVisualState}`}
        aria-label={
          agent.status === "running"
            ? "Agent running"
            : agent.status === "needs-attention"
              ? "Agent ready for your reply"
              : "Agent session idle"
        }
        title={
          agent.status === "running"
            ? `${agent.runningCount ?? 1} agent turn${
                (agent.runningCount ?? 1) === 1 ? "" : "s"
              } running`
            : agent.status === "needs-attention"
              ? "Agent finished — ready for your reply"
              : "Idle agent session — awaiting your input"
        }
      />
    ) : null;

  // Disclosure caret (or a reserved spacer when alignSlots is set so
  // workspace-less rows align with their siblings). Shared by both the
  // flat and stacked layouts; lives in the row's left gutter.
  const chevronEl = disclosure ? (
    <button
      type="button"
      className={`a2ui-sidebar-item-discl a2ui-sidebar-item-discl-${disclosure}`}
      aria-label={disclosure === "expanded" ? "Collapse" : "Expand"}
      aria-expanded={disclosure === "expanded"}
      onClick={(e) => {
        e.stopPropagation();
        onToggleDisclosure?.();
      }}
    >
      <Chevron expanded={disclosure === "expanded"} size={12} />
    </button>
  ) : alignSlots ? (
    <span className="a2ui-sidebar-item-discl-spacer" aria-hidden="true" />
  ) : null;

  const iconEl = item.iconUrl ? (
    <img
      src={item.iconUrl}
      alt=""
      aria-hidden="true"
      className="a2ui-sidebar-item-icon"
      loading="lazy"
    />
  ) : item.icon === "phone" ? (
    <span
      className="a2ui-sidebar-item-icon a2ui-sidebar-item-icon--phone"
      aria-hidden="true"
    >
      <svg
        width="11"
        height="14"
        viewBox="0 0 12 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.25" y="1.25" width="7.5" height="13.5" rx="1.6" />
        <path d="M5 12.6h2" />
      </svg>
    </span>
  ) : stacked ? (
    // Fallback repo glyph so the icon column (and the workspace guide that
    // aligns to it) stays consistent across projects without a favicon.
    <span
      className="a2ui-sidebar-item-icon a2ui-sidebar-item-icon--fallback"
      aria-hidden="true"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 4.5C2 3.7 2.7 3 3.5 3h3l1.5 1.6h4.5c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5z" />
      </svg>
    </span>
  ) : null;

  const rowClass = [
    "a2ui-sidebar-item",
    stacked ? "a2ui-sidebar-item-stacked" : "",
    item.active ? "a2ui-sidebar-item-active" : "",
    monoItems ? "a2ui-sidebar-item-mono" : "",
    disclosure ? `a2ui-sidebar-item-discl-${disclosure}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Stacked (two-line) layout — used by project rows. Name on line 1,
  // a git meta line (branch · dirty · ahead/behind) on line 2.
  if (stacked) {
    const hasMeta = !!git?.branch || !!git?.dirty || ahead > 0 || behind > 0;
    return (
      <li
        className={rowClass}
        title={tooltip}
        onClick={() =>
          onEvent("select", selectPayload(sectionId, item), item.id)
        }
        onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
      >
        {chevronEl}
        {iconEl}
        <span className="a2ui-sidebar-item-stack">
          <span className="a2ui-sidebar-item-name-row">
            {agentDotEl}
            <span className="a2ui-sidebar-item-label">{item.label}</span>
          </span>
          {hasMeta && (
            <span className="a2ui-sidebar-item-meta">
              {git?.branch && (
                <span
                  className="a2ui-sidebar-item-git-branch"
                  title={branchTitle}
                >
                  {git.branch}
                </span>
              )}
              {git?.dirty && (
                <span
                  className="a2ui-sidebar-item-git-dot"
                  aria-hidden="true"
                  title="Uncommitted changes"
                />
              )}
              {(ahead > 0 || behind > 0) && (
                <span
                  className="a2ui-sidebar-item-git-sync"
                  title={`${ahead} ahead, ${behind} behind`}
                >
                  {ahead > 0 && <span className="ae-git-ahead">↑{ahead}</span>}
                  {behind > 0 && (
                    <span className="ae-git-behind">↓{behind}</span>
                  )}
                </span>
              )}
            </span>
          )}
        </span>
        {trailingControl}
      </li>
    );
  }

  return (
    <li
      className={rowClass}
      title={tooltip}
      onClick={() => onEvent("select", selectPayload(sectionId, item), item.id)}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {chevronEl}
      {git?.dirty ? (
        <span
          className="a2ui-sidebar-item-git-dot"
          aria-hidden="true"
          title="Uncommitted changes"
        />
      ) : alignSlots ? (
        <span className="a2ui-sidebar-item-git-dot-spacer" aria-hidden="true" />
      ) : null}
      {iconEl}
      <span className="a2ui-sidebar-item-label">{item.label}</span>
      {git?.branch ? (
        <span className="a2ui-sidebar-item-git-branch" title={branchTitle}>
          {git.branch}
        </span>
      ) : null}
      {hint && <span className="a2ui-sidebar-item-hint">{hint}</span>}
      {trailingControl}
    </li>
  );
}
