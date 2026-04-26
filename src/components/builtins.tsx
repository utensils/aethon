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
    onClick?: string;
  };

  const label = resolveString(props.label, state);
  const variant = props.variant || "primary";
  const disabled = props.disabled ? resolveBoolean(props.disabled, state) : false;

  const handleClick = () => {
    if (props.onClick) {
      onEvent("click", {});
    }
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
        ? "#0e0e10"
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
