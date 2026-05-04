import type { A2UIComponent, SidebarItem } from "../../../types/a2ui";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

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
          onEvent("select", { sectionId, itemId: item.id }, item.id)
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
  const git = (item as {
    git?: {
      branch?: string;
      dirty?: boolean;
      ahead?: number;
      behind?: number;
    };
  }).git;
  const branchTitle = git?.branch
    ? `Branch: ${git.branch}${git.dirty ? " (uncommitted changes)" : ""}`
    : undefined;
  return (
    <li
      className={[
        "a2ui-sidebar-item",
        item.active ? "a2ui-sidebar-item-active" : "",
        monoItems ? "a2ui-sidebar-item-mono" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={tooltip}
      onClick={() => onEvent("select", { sectionId, itemId: item.id }, item.id)}
      onContextMenu={(e) => onItemContextMenu?.(e, item, sectionId)}
    >
      {git?.dirty ? (
        <span
          className="a2ui-sidebar-item-git-dot"
          aria-hidden="true"
          title="Uncommitted changes"
        />
      ) : null}
      <span className="a2ui-sidebar-item-label">{item.label}</span>
      {git?.branch ? (
        <span className="a2ui-sidebar-item-git-branch" title={branchTitle}>
          {git.branch}
        </span>
      ) : null}
      {hint && <span className="a2ui-sidebar-item-hint">{hint}</span>}
    </li>
  );
}
