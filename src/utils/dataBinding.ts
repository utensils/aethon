/**
 * JSON Pointer data binding utilities
 * Supports resolving dynamic values from state via JSON Pointer paths
 */

import type {
  StringValue,
  NumberValue,
  BooleanValue,
  DynamicString,
  DynamicNumber,
  DynamicBoolean,
} from "../types/a2ui";

/**
 * Check if a value is a dynamic reference
 */
function isDynamic(
  value: unknown,
): value is DynamicString | DynamicNumber | DynamicBoolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string"
  );
}

/**
 * Resolve a JSON Pointer path in state
 * JSON Pointer format: /path/to/value
 */
function resolvePointer(state: Record<string, unknown>, path: string): unknown {
  if (!path || path === "/") return state;

  // Remove leading slash and split
  const tokens = path.replace(/^\//, "").split("/");

  let current: unknown = state;
  for (const token of tokens) {
    // Unescape ~ encoding (~0 = ~, ~1 = /)
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");

    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Resolve a dynamic string value
 */
export function resolveString(
  value: StringValue,
  state: Record<string, unknown>,
): string {
  if (typeof value === "string") return value;
  if (isDynamic(value)) {
    const resolved = resolvePointer(state, value.$ref);
    return String(resolved ?? "");
  }
  return "";
}

/**
 * Resolve a dynamic number value
 */
export function resolveNumber(
  value: NumberValue,
  state: Record<string, unknown>,
): number {
  if (typeof value === "number") return value;
  if (isDynamic(value)) {
    const resolved = resolvePointer(state, value.$ref);
    return Number(resolved ?? 0);
  }
  return 0;
}

/**
 * Resolve a dynamic boolean value
 */
export function resolveBoolean(
  value: BooleanValue,
  state: Record<string, unknown>,
): boolean {
  if (typeof value === "boolean") return value;
  if (isDynamic(value)) {
    const resolved = resolvePointer(state, value.$ref);
    return Boolean(resolved);
  }
  return false;
}
