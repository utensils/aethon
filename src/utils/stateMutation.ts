// Immutable JSON Pointer write that preserves arrays. The generic
// setPointer in utils/jsonPointer turns `{...arr}` into a plain object,
// which breaks the renderer when a layout's `components`/`children`
// arrays get traversed. This walker spreads with `[...arr]` for arrays
// so the layout shape is preserved end-to-end.
export function decodeToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}

function isArrayIndex(token: string | undefined): boolean {
  return token !== undefined && /^(0|[1-9]\d*)$/.test(token);
}

export function layoutPatch<T>(payload: T, pointer: string, value: unknown): T {
  if (!pointer || pointer === "" || pointer === "/") return payload;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodeToken);
  const cloneNode = (
    node: unknown,
    nextToken: string | undefined,
  ): unknown => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === "object") {
      return { ...(node as Record<string, unknown>) };
    }
    return isArrayIndex(nextToken) ? [] : {};
  };
  const root = cloneNode(payload, tokens[0]) as
    | Record<string, unknown>
    | unknown[];
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const idx = Array.isArray(cursor) ? Number(key) : key;
    const existing = (cursor as Record<string | number, unknown>)[idx as never];
    const child = cloneNode(existing, tokens[i + 1]);
    (cursor as Record<string | number, unknown>)[idx as never] = child;
    cursor = child as Record<string, unknown> | unknown[];
  }
  const lastKey = tokens[tokens.length - 1];
  const lastIdx = Array.isArray(cursor) ? Number(lastKey) : lastKey;
  (cursor as Record<string | number, unknown>)[lastIdx as never] = value;
  return root as T;
}

// Recursive structural merge. Plain objects recurse; arrays and primitives
// replace. Used when folding the bridge's extension state snapshot into
// app state so an extension's nested key doesn't wipe siblings.
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

export function deepMergeState(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMergeState(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
