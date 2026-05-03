/**
 * Built-in A2UI component implementations
 */

import type { CSSProperties } from "react";
import type {
  BooleanValue,
  NumberValue,
  StringValue,
} from "../types/a2ui";
import {
  resolveString,
  resolveNumber,
  resolveBoolean,
} from "../utils/dataBinding";
import type { ComponentProps } from "./primitives/shared";
import { resolvedName } from "./primitives/shared";

export { Image, Icon } from "./primitives/media";
export { Text, Heading, Paragraph, Code, Divider } from "./primitives/text";
export { Card, Container, List, Table } from "./primitives/layout";
export { Button, Checkbox, Select, Slider } from "./primitives/controls";

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
