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
  pointer: unknown,
): unknown {
  if (typeof pointer !== "string") {
    return undefined;
  }
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

type PointerContainer = Record<string, unknown> | unknown[];

function isPointerContainer(value: unknown): value is PointerContainer {
  return typeof value === "object" && value !== null;
}

function isArrayIndex(token: string | undefined): boolean {
  return token !== undefined && /^(0|[1-9]\d*)$/.test(token);
}

function clonePointerContainer(
  value: unknown,
  nextToken?: string,
): PointerContainer {
  if (Array.isArray(value)) return [...value];
  if (isPointerContainer(value))
    return { ...(value as Record<string, unknown>) };
  return isArrayIndex(nextToken) ? [] : {};
}

function readPointerChild(container: PointerContainer, token: string): unknown {
  return (container as Record<string, unknown>)[token];
}

function writePointerChild(
  container: PointerContainer,
  token: string,
  value: unknown,
): void {
  (container as Record<string, unknown>)[token] = value;
}

/**
 * Returns a new state object with `value` written at `pointer`.
 * Does not mutate `state`. Intermediate objects/arrays are cloned along
 * the write path; sibling branches keep their existing references.
 */
export function setPointer(
  state: unknown[],
  pointer: string,
  value: unknown,
): unknown[];
export function setPointer(
  state: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown>;
export function setPointer(
  state: PointerContainer,
  pointer: string,
  value: unknown,
): PointerContainer {
  if (!pointer || pointer === "" || pointer === "/") {
    return state;
  }

  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodePointerToken);

  const next = clonePointerContainer(state);
  let cursor: PointerContainer = next;

  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const existing = readPointerChild(cursor, key);
    const child = clonePointerContainer(existing, tokens[i + 1]);
    writePointerChild(cursor, key, child);
    cursor = child;
  }

  writePointerChild(cursor, tokens[tokens.length - 1], value);
  return next;
}

/**
 * Returns a new state object with the value at `pointer` removed. Does not
 * mutate `state`. Intermediate objects are cloned along the path. If the
 * pointer doesn't resolve to an existing key, returns the original state
 * reference (no allocation). Empty intermediate objects are NOT pruned —
 * /a/b removed from `{a:{b:1, c:2}}` yields `{a:{c:2}}`, not `{}`. Used
 * by the ready-hydration path to wipe extension-owned slices when an
 * extension has been uninstalled.
 */
export function deletePointer(
  state: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> {
  if (!pointer || pointer === "" || pointer === "/") return state;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodePointerToken);

  // Pre-flight: walk to confirm the leaf exists. Returning the same
  // reference when no-op lets callers skip a re-render.
  let probe: unknown = state;
  for (const t of tokens) {
    if (probe === null || typeof probe !== "object") return state;
    if (!Object.hasOwn(probe, t)) return state;
    probe = (probe as Record<string, unknown>)[t];
  }

  const next = clonePointerContainer(state);
  let cursor: PointerContainer = next;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const existing = readPointerChild(cursor, key);
    const child = clonePointerContainer(existing, tokens[i + 1]);
    writePointerChild(cursor, key, child);
    cursor = child;
  }
  const leaf = tokens[tokens.length - 1];
  if (Array.isArray(cursor) && isArrayIndex(leaf)) {
    cursor.splice(Number(leaf), 1);
  } else {
    delete (cursor as Record<string, unknown>)[leaf];
  }
  return next as Record<string, unknown>;
}

/**
 * Checks if a value is a dynamic reference ($ref property)
 */
export function isDynamicRef(value: unknown): value is { $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof value.$ref === "string"
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
  return value;
}
