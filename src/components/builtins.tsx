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

interface ComponentProps {
  component: A2UIComponent;
  state: Record<string, unknown>;
  onEvent: (eventType: string, data?: unknown) => void;
  renderChildren?: () => React.ReactNode;
}

// Text component
export function Text({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    variant?: "body" | "small" | "large";
    color?: string;
  };

  const content = resolveString(props.content, state);
  const variant = props.variant || "body";
  const color = props.color;

  const style: CSSProperties = {
    color: color || "inherit",
    fontSize:
      variant === "small" ? "0.875rem" : variant === "large" ? "1.125rem" : "1rem",
  };

  return <span style={style}>{content}</span>;
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
  };

  const label = resolveString(props.label, state);
  const variant = props.variant || "primary";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;

  const handleClick = () => {
    if (disabled) return;
    onEvent("click", {});
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

// Code component
export function Code({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    language?: string;
    showLineNumbers?: BooleanValue;
  };

  const content = resolveString(props.content, state);
  const language = props.language;
  // Note: showLineNumbers could be used for future enhancement
  // const showLineNumbers = props.showLineNumbers
  //   ? resolveBoolean(props.showLineNumbers, state)
  //   : false;

  const style: CSSProperties = {
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "12px",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.875rem",
    overflow: "auto",
    whiteSpace: "pre",
  };

  return (
    <pre className="a2ui-code" style={style} data-language={language}>
      <code>{content}</code>
    </pre>
  );
}

// Image component — renders a data URL or remote URL with a max-width cap.
// Used by tool result cards (e.g. read tool returning an image) AND by
// chrome (header logo), so the className prop opts out of the default
// figure-style framing when the consumer wants raw, unbordered icon-style
// rendering.
export function Image({ component, state }: ComponentProps) {
  const props = component.props as {
    src: StringValue;
    alt?: StringValue;
    maxWidth?: NumberValue;
    caption?: StringValue;
    className?: string;
  };

  const src = resolveString(props.src, state);
  const alt = props.alt ? resolveString(props.alt, state) : "";
  const maxWidth = props.maxWidth ? resolveNumber(props.maxWidth, state) : 480;
  const caption = props.caption ? resolveString(props.caption, state) : undefined;
  const className = props.className;

  // When a className is provided, defer all styling to CSS so the consumer
  // can size + crop without fighting the default figure styles. Without
  // className, keep the full-width framed look the chat tool cards use.
  const imgStyle: CSSProperties = className
    ? { display: "block" }
    : {
        display: "block",
        maxWidth: `${maxWidth}px`,
        width: "100%",
        height: "auto",
        borderRadius: "6px",
        border: "1px solid var(--border)",
      };

  return (
    <figure
      className={className ? `a2ui-image ${className}` : "a2ui-image"}
      style={{ margin: 0 }}
    >
      {src && <img src={src} alt={alt} className={className} style={imgStyle} />}
      {caption && (
        <figcaption
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-dim)",
            marginTop: src ? "4px" : 0,
          }}
        >
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

// Heading primitive — wraps an h1/h2/h3 according to `level` prop.
export function Heading({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    level?: 1 | 2 | 3 | 4 | 5 | 6;
  };
  const content = resolveString(props.content, state);
  const level = props.level && props.level >= 1 && props.level <= 6 ? props.level : 2;
  const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
  return <Tag style={{ margin: 0 }}>{content}</Tag>;
}

// Paragraph primitive — text with default block flow.
export function Paragraph({ component, state }: ComponentProps) {
  const props = component.props as { content: StringValue };
  const content = resolveString(props.content, state);
  return <p style={{ margin: "0 0 8px 0", lineHeight: 1.5 }}>{content}</p>;
}

// Divider primitive — thin horizontal rule.
export function Divider({ component }: ComponentProps) {
  const props = component.props as
    | { orientation?: "horizontal" | "vertical" }
    | undefined;
  const vertical = props?.orientation === "vertical";
  const style: CSSProperties = vertical
    ? {
        width: 1,
        alignSelf: "stretch",
        background: "var(--border)",
        margin: "0 8px",
      }
    : {
        height: 1,
        width: "100%",
        background: "var(--border)",
        margin: "8px 0",
        border: "none",
      };
  return vertical ? <span style={style} aria-hidden /> : <hr style={style} />;
}

// Checkbox primitive — fires `change` with `{ value: boolean }`.
export function Checkbox({ component, state, onEvent }: ComponentProps) {
  const props = component.props as {
    value?: BooleanValue;
    label?: StringValue;
    disabled?: BooleanValue;
  };
  const checked = props.value ? resolveBoolean(props.value, state) : false;
  const label = props.label ? resolveString(props.label, state) : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
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
        disabled={disabled}
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
  };
  const value = props.value ? resolveString(props.value, state) : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
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
  };
  const value = props.value ? resolveNumber(props.value, state) : 0;
  const min = props.min ? resolveNumber(props.min, state) : 0;
  const max = props.max ? resolveNumber(props.max, state) : 100;
  const step = props.step ? resolveNumber(props.step, state) : 1;
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const showValue = props.showValue
    ? resolveBoolean(props.showValue, state)
    : false;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <input
        type="range"
        value={value}
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
              const cellOverlay = { $row: row, $index: ri, $parent: state };
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
  };

  const value = props.value ? resolveString(props.value, state) : "";
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;

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
  };

  return (
    <input
      type="text"
      className="a2ui-text-input"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      style={style}
    />
  );
}
