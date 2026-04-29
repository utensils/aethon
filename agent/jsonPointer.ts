/**
 * Bridge-side JSON Pointer helpers. Mirrors the frontend's
 * `src/utils/jsonPointer.ts` so the agent's retained state
 * (`extensionStateTree`, `perTabExtState`) folds writes the same way the
 * frontend does. Specifically: arrays stay arrays under nested writes,
 * so a `/canvas/components/0/props/title` patch leaves
 * `canvas.components` as `[{...}]` rather than `{0: {...}}`.
 *
 * Without that array-preservation, ready-replay rebuilds the frontend's
 * canvas from a malformed shape, and any read-back (e.g.
 * `aethon.canvas.append(...)` consulting the per-tab mirror) sees
 * something that is no longer an array.
 *
 * Extracted so it can be unit-tested without booting `agent/main.ts`.
 */

const PTR_TOKEN_DECODE = (token: string): string =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Apply a JSON Pointer write, returning a new root with the value set
 * at the path. Each intermediate node is cloned (arrays as arrays,
 * objects as objects). Missing intermediates default to `{}`.
 */
export function setAtPointer(
  state: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  if (!pointer || pointer === "" || pointer === "/") return state;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(PTR_TOKEN_DECODE);
  const cloneNode = (node: unknown): Record<string, unknown> | unknown[] => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === "object") {
      return { ...(node as Record<string, unknown>) };
    }
    return {};
  };
  const next = { ...state } as Record<string | number, unknown>;
  let cursor: Record<string | number, unknown> | unknown[] = next;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const idx = Array.isArray(cursor) ? Number(key) : key;
    const existing = (cursor as Record<string | number, unknown>)[idx];
    const child = cloneNode(existing);
    (cursor as Record<string | number, unknown>)[idx] = child;
    cursor = child;
  }
  const lastKey = tokens[tokens.length - 1];
  const lastIdx = Array.isArray(cursor) ? Number(lastKey) : lastKey;
  (cursor as Record<string | number, unknown>)[lastIdx] = value;
  return next;
}
