/**
 * `Layout` — CSS Grid container with template-areas. Children opt into a
 * region by setting their own `area` prop; the layout reads it and
 * wraps the child in a div with `grid-area: <area>`.
 *
 * Visibility behavior: a child sets `visible` to gate its render. The
 * sidebar, files-sidebar, and terminal cells stay in the DOM even when
 * hidden so their internal motion (sidebar resize, terminal scroll
 * state) doesn't churn on toggle.
 */

import { resolvePointer } from "../../../utils/jsonPointer";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type {
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../../types/a2ui";
import type { CSSProperties } from "react";

export function Layout({
  component,
  state,
  renderChild,
}: BuiltinComponentProps) {
  const props = component.props as {
    columns?: StringValue;
    rows?: StringValue;
    // Inline array OR $ref to a state-bound array. Bound form lets the
    // grid template-areas swap reactively when the user toggles a layout
    // option (e.g. show/hide the sidebar) without requiring a full
    // setLayout replacement.
    areas?: string[] | { $ref: string };
    gap?: NumberValue;
    // Optional slot → grid-area remap. By default a child's `slot` prop
    // resolves to a grid area of the same name; this map lets a layout
    // host the standard composites under non-canonical area names. See
    // `./slots.json` for the canonical slot list.
    slotMap?: Record<string, string>;
  };

  const columns = props.columns
    ? resolveString(props.columns, state)
    : "minmax(0,1fr)";
  const rows = props.rows ? resolveString(props.rows, state) : "minmax(0,1fr)";
  const gap = props.gap ? resolveNumber(props.gap, state) : 0;
  const resolvedAreas = (() => {
    const a = props.areas;
    if (!a) return undefined;
    if (Array.isArray(a)) return a;
    if (typeof a === "object" && "$ref" in a) {
      const v = resolvePointer(state, a.$ref);
      return Array.isArray(v) ? (v as string[]) : undefined;
    }
    return undefined;
  })();
  const areas = resolvedAreas
    ? resolvedAreas.map((row) => `"${row}"`).join(" ")
    : undefined;
  const slotMap = props.slotMap ?? {};

  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: columns,
    gridTemplateRows: rows,
    gridTemplateAreas: areas,
    gap: `${gap}px`,
    height: "100%",
    width: "100%",
    minHeight: 0,
  };

  return (
    <div className="a2ui-layout" style={style}>
      {component.children?.map((child) => {
        const childProps = child.props as
          | { area?: string; visible?: BooleanValue }
          | undefined;
        // The child's `area` prop doubles as the slot name. By default the
        // slot name IS the CSS grid area; an optional slotMap on the root
        // layout lets a non-canonical layout host the standard composites
        // under a different grid area name (e.g. slotMap.composer = "bottom").
        // See `./slots.json` for the canonical slot list.
        const slotName = childProps?.area;
        const area = slotName ? (slotMap[slotName] ?? slotName) : undefined;
        const visible =
          childProps?.visible === undefined
            ? true
            : resolveBoolean(childProps.visible, state);
        const keepsMountedForMotion =
          area === "sidebar" || area === "files-sidebar" || area === "terminal";
        const cellStyle: CSSProperties = {
          gridArea: area,
          minWidth: 0,
          minHeight: 0,
          display: visible || keepsMountedForMotion ? "flex" : "none",
          position: slotName === "canvas" ? "relative" : undefined,
        };
        return (
          <div
            key={child.id}
            className="a2ui-layout-cell"
            data-area={area}
            data-slot={slotName}
            data-visible={visible ? "true" : "false"}
            style={cellStyle}
          >
            {renderChild?.(child)}
          </div>
        );
      })}
    </div>
  );
}
