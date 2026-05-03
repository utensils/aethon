/**
 * Built-in A2UI component implementations
 */

import type { CSSProperties } from "react";
import type {
  A2UIComponent,
  BooleanValue,
  NumberValue,
  StringValue,
} from "../types/a2ui";
import {
  resolveString,
  resolveNumber,
  resolveBoolean,
} from "../utils/dataBinding";
import { resolvePointer } from "../utils/jsonPointer";
import type { ComponentProps } from "./primitives/shared";
import { resolvedName } from "./primitives/shared";

export { Image, Icon } from "./primitives/media";
export { Text, Heading, Paragraph, Code, Divider } from "./primitives/text";

function formValues(form: HTMLFormElement): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const data = new FormData(form);
  for (const [name, value] of data.entries()) {
    const normalized = value instanceof File ? value.name : value;
    const existing = values[name];
    if (existing === undefined) {
      values[name] = normalized;
    } else if (Array.isArray(existing)) {
      existing.push(normalized);
    } else {
      values[name] = [existing, normalized];
    }
  }

  // FormData omits unchecked checkboxes and reports checked boxes as "on".
  // Normalize named checkboxes to stable booleans.
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement)) continue;
    if (el.type !== "checkbox" || !el.name) continue;
    values[el.name] = el.checked;
  }

  return values;
}

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

// Button component
export function Button({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    label: StringValue;
    variant?: "primary" | "secondary" | "ghost";
    disabled?: BooleanValue;
    /** Override the emitted event name. Defaults to "click". Useful for
     *  declarative override templates that need to emit a host-specific
     *  event — e.g. a `share-mode-badge` template that wants its button
     *  to cycle the mode writes
     *  `{type:"button", props:{event:"cycle-share-mode"}}` so the host
     *  adapter recognizes the intent without translation heuristics.
     *  Optional `data` is forwarded as the event payload. */
    event?: string;
    data?: unknown;
  };

  const label = resolveString(props.label, state);
  const variant = props.variant || "primary";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const eventName = typeof props.event === "string" && props.event ? props.event : "click";
  const eventData = props.data !== undefined ? props.data : {};

  const handleClick = () => {
    if (disabled) return;
    onEvent(eventName, eventData);
  };

  const style: CSSProperties = {
    background:
      variant === "primary"
        ? "var(--accent)"
        : variant === "secondary"
          ? "var(--bg-input)"
          : "transparent",
    color:
      variant === "primary"
        ? "var(--btn-text)"
        : variant === "secondary"
          ? "var(--text)"
          : "var(--accent)",
    border:
      variant === "ghost" ? "1px solid var(--border)" : "none",
    borderRadius: "6px",
    padding: "8px 16px",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    maxWidth: "100%",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      style={style}
    >
      {label}
    </button>
  );
}

// Container component
export function Container({ component, state, renderChildren }: ComponentProps) {
  const props = component.props as {
    direction?: "row" | "column";
    gap?: NumberValue;
    padding?: NumberValue;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "space-between";
    className?: string;
  };

  const direction = props.direction || "column";
  const gap = props.gap ? resolveNumber(props.gap, state) : 8;
  const padding = props.padding ? resolveNumber(props.padding, state) : 0;
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

  return (
    <div className={cls} style={style}>
      {renderChildren && renderChildren()}
    </div>
  );
}

// Checkbox primitive — fires `change` with `{ value: boolean }`.
export function Checkbox({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: BooleanValue;
    label?: StringValue;
    disabled?: BooleanValue;
    name?: StringValue;
    required?: BooleanValue;
  };
  const checked = props.value ? resolveBoolean(props.value, state) : false;
  const label = props.label ? resolveString(props.label, state) : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const required = props.required ? resolveBoolean(props.required, state) : false;
  const name = resolvedName(props.name, state);
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        name={name}
        disabled={disabled}
        required={required}
        onChange={(e) => onEvent("change", { value: e.target.checked })}
      />
      {label && <span>{label}</span>}
    </label>
  );
}

// Select primitive — fires `change` with `{ value: string }`.
export function Select({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: StringValue;
    options: { value: string; label?: string }[] | { $ref: string };
    disabled?: BooleanValue;
    placeholder?: StringValue;
    name?: StringValue;
    required?: BooleanValue;
  };
  const value = props.value ? resolveString(props.value, state) : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const required = props.required ? resolveBoolean(props.required, state) : false;
  const name = resolvedName(props.name, state);
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const options: { value: string; label?: string }[] = (() => {
    if (Array.isArray(props.options)) return props.options;
    if (props.options && typeof props.options === "object" && "$ref" in props.options) {
      const resolved = resolvePointer(state, props.options.$ref);
      return Array.isArray(resolved)
        ? (resolved as { value: string; label?: string }[])
        : [];
    }
    return [];
  })();
  const style: CSSProperties = {
    background: "var(--bg-input)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: "0.875rem",
    cursor: disabled ? "not-allowed" : "pointer",
  };
  return (
    <select
      style={style}
      value={value}
      name={name}
      required={required}
      disabled={disabled}
      onChange={(e) => onEvent("change", { value: e.target.value })}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label ?? o.value}
        </option>
      ))}
    </select>
  );
}

// Slider primitive — fires `change` with `{ value: number }`.
export function Slider({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: NumberValue;
    min?: NumberValue;
    max?: NumberValue;
    step?: NumberValue;
    disabled?: BooleanValue;
    showValue?: BooleanValue;
    name?: StringValue;
  };
  const value = props.value ? resolveNumber(props.value, state) : 0;
  const min = props.min ? resolveNumber(props.min, state) : 0;
  const max = props.max ? resolveNumber(props.max, state) : 100;
  const step = props.step ? resolveNumber(props.step, state) : 1;
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const showValue = props.showValue
    ? resolveBoolean(props.showValue, state)
    : false;
  const name = resolvedName(props.name, state);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input
        type="range"
        value={value}
        name={name}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) =>
          onEvent("change", { value: Number(e.target.value) })
        }
      />
      {showValue && (
        <span style={{ fontSize: "0.875rem", color: "var(--text-dim)" }}>
          {value}
        </span>
      )}
    </span>
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

// TextInput component
export function TextInput({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    onChange?: string;
    onSubmit?: string;
    name?: StringValue;
    required?: BooleanValue;
    autocomplete?: StringValue;
  };

  const value = props.value ? resolveString(props.value, state) : "";
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const required = props.required ? resolveBoolean(props.required, state) : false;
  const name = resolvedName(props.name, state);
  const autoComplete = props.autocomplete
    ? resolveString(props.autocomplete, state)
    : undefined;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onEvent("change", { value: e.target.value });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && props.onSubmit) {
      onEvent("submit", { value: (e.target as HTMLInputElement).value });
    }
  };

  const style: CSSProperties = {
    background: "var(--bg-input)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "0.875rem",
    outline: "none",
    width: "100%",
    minWidth: 0,
  };

  return (
    <input
      type="text"
      className="a2ui-text-input"
      value={value}
      name={name}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      autoComplete={autoComplete}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      style={style}
    />
  );
}

// DatePicker primitive — native date input. Fires `change` with
// `{ value: "YYYY-MM-DD" }` and participates in form serialization when
// `name` is supplied.
export function DatePicker({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: StringValue;
    min?: StringValue;
    max?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    required?: BooleanValue;
    name?: StringValue;
  };
  const value = props.value ? resolveString(props.value, state) : "";
  const min = props.min ? resolveString(props.min, state) : undefined;
  const max = props.max ? resolveString(props.max, state) : undefined;
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : undefined;
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const required = props.required ? resolveBoolean(props.required, state) : false;
  const name = resolvedName(props.name, state);
  const style: CSSProperties = {
    background: "var(--bg-input)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "7px 10px",
    fontSize: "0.875rem",
    minWidth: 0,
    maxWidth: "100%",
    colorScheme: "inherit",
  };
  return (
    <input
      type="date"
      className="a2ui-date-picker"
      value={value}
      min={min}
      max={max}
      name={name}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      onChange={(e) => onEvent("change", { value: e.target.value })}
      style={style}
    />
  );
}

// FormField primitive — label / help / error wrapper for controls.
export function FormField({ component, state, renderChildren }: ComponentProps) {
  const props = component.props as {
    label?: StringValue;
    description?: StringValue;
    error?: StringValue;
    required?: BooleanValue;
  };
  const label = props.label ? resolveString(props.label, state) : undefined;
  const description = props.description
    ? resolveString(props.description, state)
    : undefined;
  const error = props.error ? resolveString(props.error, state) : undefined;
  const required = props.required ? resolveBoolean(props.required, state) : false;
  return (
    <label
      className="a2ui-form-field"
      style={{
        display: "grid",
        gap: 6,
        minWidth: 0,
        color: "var(--text)",
      }}
    >
      {label && (
        <span style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
          {label}
          {required && <span style={{ color: "var(--accent)" }}> *</span>}
        </span>
      )}
      {renderChildren && renderChildren()}
      {description && !error && (
        <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
          {description}
        </span>
      )}
      {error && (
        <span style={{ fontSize: "0.75rem", color: "var(--error)" }}>
          {error}
        </span>
      )}
    </label>
  );
}

// Form primitive — groups child controls and fires `submit` with
// `{ values: Record<string, unknown> }`. Named child inputs participate
// automatically through native FormData.
export function Form({ component, state, onEvent, renderChildren }: ComponentProps) {
  const props = component.props as {
    submitLabel?: StringValue;
    disabled?: BooleanValue;
    gap?: NumberValue;
    direction?: "row" | "column";
  };
  const submitLabel = props.submitLabel
    ? resolveString(props.submitLabel, state)
    : undefined;
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const gap = props.gap ? resolveNumber(props.gap, state) : 10;
  const direction = props.direction || "column";
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (disabled) return;
    onEvent("submit", { values: formValues(e.currentTarget) });
  };
  return (
    <form
      className="a2ui-form"
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: direction,
        gap: `${gap}px`,
        alignItems: direction === "row" ? "center" : "stretch",
        minWidth: 0,
        maxWidth: "100%",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <fieldset
        disabled={disabled}
        style={{
          display: "contents",
          border: 0,
          padding: 0,
          margin: 0,
          minInlineSize: 0,
        }}
      >
        {renderChildren && renderChildren()}
        {submitLabel && (
          <button
            type="submit"
            style={{
              background: "var(--accent)",
              color: "var(--btn-text)",
              border: "none",
              borderRadius: 6,
              padding: "8px 14px",
              fontSize: "0.875rem",
              fontWeight: 650,
              cursor: disabled ? "not-allowed" : "pointer",
              maxWidth: "100%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {submitLabel}
          </button>
        )}
      </fieldset>
    </form>
  );
}
