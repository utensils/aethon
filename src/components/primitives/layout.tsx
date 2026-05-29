/**
 * Layout A2UI primitives — Card, Container, List, Table.
 */

import type { CSSProperties } from "react";
import type {
  A2UIComponent,
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { resolvePointer } from "../../utils/jsonPointer";
import { isMacOS } from "../../utils/platform";
import { onWindowDragMouseDown } from "../../utils/windowDrag";
import type { ComponentProps } from "./shared";

// Card component
export function Card({ component, state, renderChildren }: ComponentProps) {
  const props = component.props as {
    title?: StringValue;
    description?: StringValue;
    padding?: NumberValue;
  };

  const title = props.title ? resolveString(props.title, state) : undefined;
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const padding = props.padding ? resolveNumber(props.padding, state) : 16;

  const style: CSSProperties = {
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    padding: `${padding}px`,
    minWidth: 0,
    maxWidth: "100%",
  };

  return (
    <div className="a2ui-card" style={style}>
      {title && <h3 style={{ margin: "0 0 8px 0" }}>{title}</h3>}
      {description && (
        <p style={{ margin: "0 0 12px 0", color: "var(--text-dim)" }}>
          {description}
        </p>
      )}
      {renderChildren && renderChildren()}
    </div>
  );
}

// Container component
export function Container({
  component,
  state,
  renderChildren,
}: ComponentProps) {
  const props = component.props as {
    direction?: "row" | "column";
    gap?: NumberValue;
    padding?: NumberValue;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "space-between";
    className?: string;
    /** When true, the container becomes a macOS window drag region. Emits
     *  `data-tauri-drag-region="deep"`, which Tauri's drag handler treats as
     *  "drag on a click anywhere in this subtree" — except over elements it
     *  recognizes as clickable (BUTTON / INPUT / A / SELECT / TEXTAREA /
     *  LABEL / SUMMARY, contenteditable, `tabindex`, or an interactive
     *  `role`), where the click passes through normally. So the header fill
     *  and its text labels move the window while the pickers/buttons stay
     *  clickable. Used under the macOS overlay titlebar; a no-op on
     *  Linux/Windows. */
    dragRegion?: BooleanValue;
  };

  const direction = props.direction || "column";
  // Use `!= null` (not truthiness) so an explicit `gap: 0` / `padding: 0`
  // in the layout is honored — a falsy `0` previously fell through to the
  // default 8px, leaving containers that asked for no gap with one anyway.
  const gap = props.gap != null ? resolveNumber(props.gap, state) : 8;
  const padding = props.padding != null ? resolveNumber(props.padding, state) : 0;
  const align = props.align || "stretch";
  const justify = props.justify || "start";

  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction,
    gap: `${gap}px`,
    padding: `${padding}px`,
    alignItems: align,
    justifyContent: justify,
    width: "100%",
    minWidth: 0,
    minHeight: 0,
  };

  const cls = props.className
    ? `a2ui-container ${props.className}`
    : "a2ui-container";

  // Drag regions only matter under the macOS overlay titlebar; on
  // Linux/Windows the native titlebar handles dragging, so don't emit the
  // attribute there (keeps non-mac chrome behaviour unchanged).
  const dragRegion =
    isMacOS() && props.dragRegion
      ? resolveBoolean(props.dragRegion, state)
      : false;

  return (
    <div
      className={cls}
      style={style}
      {...(dragRegion
        ? {
            "data-tauri-drag-region": "deep",
            onMouseDown: onWindowDragMouseDown,
          }
        : {})}
    >
      {renderChildren && renderChildren()}
    </div>
  );
}

// List primitive — renders an array via for-each-style template-per-item.
// Conceptually a thin wrapper around for-each that ships with default
// list affordances (ul/ol semantics, optional ordered styling). Items
// are bound via `items` ($ref or inline); each `children` template
// expands per element with /$item / /$index / /$parent in scope.
export function List({
  component,
  state,
  renderChildWithState,
}: ComponentProps & {
  renderChildWithState?: (
    child: A2UIComponent,
    overlay: Record<string, unknown>,
  ) => React.ReactNode;
}) {
  const props = component.props as {
    items: unknown;
    ordered?: BooleanValue;
  };
  let items: unknown = props.items;
  if (items && typeof items === "object" && "$ref" in items) {
    items = resolvePointer(state, (items as { $ref: string }).$ref);
  }
  const list = Array.isArray(items) ? items : [];
  const ordered = props.ordered ? resolveBoolean(props.ordered, state) : false;
  const Tag = ordered ? "ol" : "ul";
  const childTemplates = component.children ?? [];
  return (
    <Tag style={{ margin: 0, paddingLeft: 20 }}>
      {list.map((item, index) => (
        <li key={index}>
          {renderChildWithState
            ? childTemplates.map((child, ci) => (
                <div key={ci}>
                  {renderChildWithState(child, {
                    $item: item,
                    $index: index,
                    $parent: state,
                  })}
                </div>
              ))
            : // Fallback: stringify the item if no template / scoped renderer
              String(item ?? "")}
        </li>
      ))}
    </Tag>
  );
}

// Table primitive — header row + data rows. Columns drive each cell's
// rendering; `cell` is an optional template per column with /$row in
// scope (the row object). Without `cell`, the column's `field` is used
// as a key into the row to print plain text.
export function Table({
  component,
  state,
  renderChildWithState,
}: ComponentProps & {
  renderChildWithState?: (
    child: A2UIComponent,
    overlay: Record<string, unknown>,
  ) => React.ReactNode;
}) {
  const props = component.props as {
    rows: unknown;
    columns: {
      header?: string;
      field?: string;
      width?: string;
      cell?: A2UIComponent;
    }[];
  };
  let rows: unknown = props.rows;
  if (rows && typeof rows === "object" && "$ref" in rows) {
    rows = resolvePointer(state, (rows as { $ref: string }).$ref);
  }
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(props.columns) ? props.columns : [];
  const tableStyle: CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.9rem",
    minWidth: 0,
  };
  const cellStyle: CSSProperties = {
    padding: "6px 10px",
    borderBottom: "1px solid var(--border)",
    textAlign: "left",
  };
  const headerStyle: CSSProperties = {
    ...cellStyle,
    color: "var(--text-dim)",
    fontWeight: 600,
    fontSize: "0.8rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
  return (
    <div style={{ maxWidth: "100%", overflowX: "auto" }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} style={{ ...headerStyle, width: c.width }}>
                {c.header ?? c.field ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row, ri) => (
            <tr key={ri}>
              {cols.map((c, ci) => {
                // Per-cell scope: $row (whole row), $index (row position),
                // $parent (surrounding state), $column (column metadata —
                // header/field/width), $cell (resolved value at the column's
                // field path on the row, undefined when field is absent).
                const cellValue =
                  typeof c.field === "string" &&
                  row !== null &&
                  typeof row === "object"
                    ? (row as Record<string, unknown>)[c.field]
                    : undefined;
                const cellOverlay = {
                  $row: row,
                  $index: ri,
                  $parent: state,
                  $column: {
                    field: c.field,
                    header: c.header,
                    width: c.width,
                  },
                  $cell: cellValue,
                };
                if (c.cell && renderChildWithState) {
                  return (
                    <td key={ci} style={cellStyle}>
                      {renderChildWithState(c.cell, cellOverlay)}
                    </td>
                  );
                }
                const v =
                  c.field && row && typeof row === "object"
                    ? (row as Record<string, unknown>)[c.field]
                    : "";
                return (
                  <td key={ci} style={cellStyle}>
                    {String(v ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
