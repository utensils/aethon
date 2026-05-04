/**
 * A2UI layout manipulation.
 *
 * The "active layout" the bridge serves to extensions has three layered
 * sources, in priority order:
 *
 *   1. extensionLayout (set by setLayout) — full replacement.
 *   2. bootLayout + pendingLayoutPatches — patches queued before any
 *      setLayout fires; folded in deterministically on read.
 *   3. null — no boot layout known yet (raw `bun run`, no Tauri shell).
 *
 * `patchLayout` either updates extensionLayout in place (clones each
 * frame) or queues against pendingLayoutPatches when no setLayout has
 * been called yet. Reload-replay applies queued patches in the same
 * sequence the live frontend received them.
 */

import type {
  AethonAgentState,
  LayoutSlotsCatalogue,
  MutationResult,
  RegisteredLayout,
} from "./state";
import { trackMutation } from "./mutation-ack";

export interface LayoutManagerDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
}

const BUILTIN_LAYOUT_IDS = new Set([
  "workstation",
  "editorial",
  "command-deck",
  "live-layout",
]);

/** Decode a JSON Pointer token (RFC 6901). `~1` → `/`, `~0` → `~`. */
function decodePointerToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Layout-aware patch that preserves arrays (mirror of the frontend's
 *  layoutPatch). Used to fold patch_layout calls into the retained
 *  layout so ready/report replay matches the live frontend state. */
export function patchLayoutTree(
  payload: unknown,
  pointer: string,
  value: unknown,
): unknown {
  if (!pointer || pointer === "" || pointer === "/") return payload;
  const path = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  const tokens = path.split("/").map(decodePointerToken);
  const cloneNode = (node: unknown): Record<string, unknown> | unknown[] => {
    if (Array.isArray(node)) return [...node];
    if (node && typeof node === "object") {
      return { ...(node as Record<string, unknown>) };
    }
    return {};
  };
  const root = cloneNode(payload);
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const idx = Array.isArray(cursor) ? Number(key) : key;
    const existing = (cursor as Record<string | number, unknown>)[idx as never];
    const child = cloneNode(existing);
    (cursor as Record<string | number, unknown>)[idx as never] = child;
    cursor = child;
  }
  const lastKey = tokens[tokens.length - 1];
  const lastIdx = Array.isArray(cursor) ? Number(lastKey) : lastKey;
  (cursor as Record<string | number, unknown>)[lastIdx as never] = value;
  return root;
}

/** Compute the effective layout tree the frontend would render right now. */
export function effectiveLayout(state: AethonAgentState): unknown {
  if (state.extensionLayout) return state.extensionLayout;
  if (!state.bootLayout) return null;
  if (state.pendingLayoutPatches.length === 0) return state.bootLayout;
  let tree = state.bootLayout;
  for (const { path, value } of state.pendingLayoutPatches) {
    tree = patchLayoutTree(tree, path, value);
  }
  return tree;
}

export function setLayout(
  state: AethonAgentState,
  deps: LayoutManagerDeps,
  payload: unknown,
): Promise<MutationResult> {
  if (!payload || typeof payload !== "object") {
    return Promise.resolve({ ok: false, error: "payload required" });
  }
  state.extensionLayout = payload;
  // The new layout replaces whatever the pending patches were targeting —
  // drop them so they don't replay against the new tree.
  state.pendingLayoutPatches = [];
  const { id, promise } = trackMutation(state);
  deps.send({ type: "layout_set", mutationId: id, payload });
  deps.scheduleStateFileWrite();
  return promise;
}

export function patchLayout(
  state: AethonAgentState,
  deps: LayoutManagerDeps,
  path: string,
  value: unknown,
): Promise<MutationResult> {
  if (!path || typeof path !== "string") {
    return Promise.resolve({ ok: false, error: "path required" });
  }
  if (state.extensionLayout) {
    state.extensionLayout = patchLayoutTree(state.extensionLayout, path, value);
  } else {
    state.pendingLayoutPatches.push({ path, value });
  }
  const { id, promise } = trackMutation(state);
  deps.send({ type: "layout_patch", mutationId: id, path, value });
  deps.scheduleStateFileWrite();
  return promise;
}

export function registerLayout(
  state: AethonAgentState,
  deps: LayoutManagerDeps,
  entry: unknown,
): Promise<MutationResult> {
  if (!entry || typeof entry !== "object") {
    return Promise.resolve({
      ok: false,
      error: "registerLayout requires { id, name, payload }",
    });
  }
  const obj = entry as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    payload?: unknown;
  };
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!/^[A-Za-z][\w-]*$/.test(id)) {
    const errorMsg = "registerLayout: id must match /^[A-Za-z][\\w-]*$/";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  if (BUILTIN_LAYOUT_IDS.has(id)) {
    const errorMsg = `registerLayout: "${id}" is a reserved built-in id`;
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  if (!name) {
    const errorMsg = "registerLayout: name must be a non-empty string";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  if (!obj.payload || typeof obj.payload !== "object") {
    const errorMsg = "registerLayout: payload must be an A2UI object";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  state.extensionLayouts.set(id, {
    id,
    name,
    ...(description ? { description } : {}),
    payload: obj.payload as Record<string, unknown>,
  });
  const list = [...state.extensionLayouts.values()];
  const { id: mutationId, promise } = trackMutation(state);
  deps.send({ type: "extension_layouts", mutationId, layouts: list });
  deps.scheduleStateFileWrite();
  return promise;
}

export function unregisterLayout(
  state: AethonAgentState,
  deps: LayoutManagerDeps,
  idValue: unknown,
): Promise<MutationResult> {
  const id = typeof idValue === "string" ? idValue.trim() : "";
  if (!id) {
    return Promise.resolve({
      ok: false,
      error: "unregisterLayout: id must be a non-empty string",
    });
  }
  if (!state.extensionLayouts.delete(id)) {
    return Promise.resolve({
      ok: false,
      error: `unregisterLayout: "${id}" is not a registered layout`,
    });
  }
  const list = [...state.extensionLayouts.values()];
  const { id: mutationId, promise } = trackMutation(state);
  deps.send({ type: "extension_layouts", mutationId, layouts: list });
  deps.scheduleStateFileWrite();
  return promise;
}

export function listLayouts(
  state: AethonAgentState,
): { id: string; name: string; description?: string }[] {
  return [...state.extensionLayouts.values()].map(
    (l: RegisteredLayout) => ({
      id: l.id,
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
    }),
  );
}

export function getLayout(state: AethonAgentState): unknown {
  return effectiveLayout(state);
}

export function getLayoutSlots(
  state: AethonAgentState,
): LayoutSlotsCatalogue | null {
  return state.layoutSlotsCatalogue ?? null;
}

/** Compose a one-line summary of the active layout for the runtime
 *  snapshot. The full layout is available via getLayout(); this is a
 *  human-readable hint suitable for the system prompt and state file. */
export function summarizeLayout(state: AethonAgentState): string {
  let layout: unknown;
  let prefix: string;
  if (state.extensionLayout) {
    layout = state.extensionLayout;
    prefix = "extension layout (setLayout)";
  } else if (state.bootLayout) {
    let tree = state.bootLayout;
    for (const { path, value } of state.pendingLayoutPatches) {
      tree = patchLayoutTree(tree, path, value);
    }
    layout = tree;
    prefix =
      state.pendingLayoutPatches.length > 0
        ? `default-layout (boot tree + ${state.pendingLayoutPatches.length} patch(es))`
        : "default-layout (boot tree)";
  } else {
    return state.pendingLayoutPatches.length > 0
      ? `unknown layout (${state.pendingLayoutPatches.length} pending patch(es))`
      : "unknown layout (no boot tree)";
  }
  const typed = layout as { components?: unknown[] } | null;
  const root = typed?.components?.[0] as
    | { type?: string; props?: { columns?: string; areas?: string[] } }
    | undefined;
  const cols = root?.props?.columns ?? "?";
  const sidebarSide = (() => {
    const areas = root?.props?.areas;
    if (!Array.isArray(areas) || areas.length === 0) return "?";
    const firstRow = String(areas[0]).split(/\s+/);
    if (firstRow[0] === "sidebar") return "left";
    if (firstRow[firstRow.length - 1] === "sidebar") return "right";
    return "custom";
  })();
  return `${prefix} — root=${root?.type ?? "?"}, columns="${cols}", sidebar=${sidebarSide}`;
}

export interface LayoutStructureSummary {
  rootId: string;
  rootType: string;
  columns?: string;
  rows?: string;
  areas?: string[];
  children: { id: string; type: string; area?: string }[];
}

/** Structural decomposition of the active layout: root id/type, grid
 *  template, and a flat child list (id/type/area). Stripped of state /
 *  props / nested children so the snapshot stays small. Null when no
 *  tree is known yet. */
export function summarizeLayoutStructure(
  state: AethonAgentState,
): LayoutStructureSummary | null {
  let layout: unknown;
  if (state.extensionLayout) {
    layout = state.extensionLayout;
  } else if (state.bootLayout) {
    let tree = state.bootLayout;
    for (const { path, value } of state.pendingLayoutPatches) {
      tree = patchLayoutTree(tree, path, value);
    }
    layout = tree;
  } else {
    return null;
  }
  const typed = layout as { components?: unknown[] } | null;
  const root = typed?.components?.[0] as
    | {
        id?: string;
        type?: string;
        props?: { columns?: string; rows?: string; areas?: string[] };
        children?: { id?: string; type?: string; props?: { area?: string } }[];
      }
    | undefined;
  if (!root) return null;
  return {
    rootId: root.id ?? "",
    rootType: root.type ?? "",
    ...(root.props?.columns ? { columns: root.props.columns } : {}),
    ...(root.props?.rows ? { rows: root.props.rows } : {}),
    ...(root.props?.areas ? { areas: root.props.areas } : {}),
    children: (root.children ?? []).map((c) => ({
      id: c.id ?? "",
      type: c.type ?? "",
      ...(c.props?.area ? { area: c.props.area } : {}),
    })),
  };
}
