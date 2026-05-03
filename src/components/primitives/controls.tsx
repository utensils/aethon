/**
 * Control A2UI primitives — Button, Checkbox, Select, Slider.
 */

import type { CSSProperties } from "react";
import type {
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
import type { ComponentProps } from "./shared";
import { resolvedName } from "./shared";

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
