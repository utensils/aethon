/**
 * JSON Pointer utilities for A2UI data binding
 * Implements RFC 6901 JSON Pointer specification
 */

/**
 * Resolves a JSON Pointer path to a value in the state object
 * @param state - The state object to resolve from
 * @param pointer - JSON Pointer path (e.g., "/user/name" or "/items/0/title")
 * @returns The resolved value or undefined if not found
 */
export function resolvePointer(
  state: Record<string, unknown>,
  pointer: string,
): unknown {
  if (!pointer || pointer === "") {
    return state;
  }

  // Remove leading slash
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;

  if (path === "") {
    return state;
  }

  // Split by unescaped slashes and decode escape sequences
  const tokens = path.split("/").map(decodePointerToken);

  // Navigate through the object
  let current: unknown = state;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Decodes a JSON Pointer token
 * ~1 decodes to /
 * ~0 decodes to ~
 */
function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Checks if a value is a dynamic reference ($ref property)
 */
export function isDynamicRef(
  value: unknown,
): value is { $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string"
  );
}

/**
 * Resolves a value that might be static or dynamic
 * @param value - The value to resolve (string, number, boolean, or {$ref: string})
 * @param state - The state object for resolving dynamic references
 * @returns The resolved value
 */
export function resolveValue<T>(
  value: T | { $ref: string },
  state: Record<string, unknown>,
): T {
  if (isDynamicRef(value)) {
    return resolvePointer(state, value.$ref) as T;
  }
  return value as T;
}
