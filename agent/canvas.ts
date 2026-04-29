/**
 * Programmatic canvas push API — sugar over `setState("/canvas", ...)`.
 *
 * Extracted from `agent/main.ts` so it has a unit-test surface without
 * spinning up the full bridge. The factory takes `setState` and a
 * per-tab canvas reader as plain dependencies; the bridge wires them to
 * its real `_setState` and `perTabExtState` map. Pure module — no I/O,
 * no globals, no shared state.
 *
 * The four operations:
 *   emit(c | c[])    — replace `/canvas` with `{components: [...]}`
 *   append(c | c[])  — read existing components, push new ones, write back
 *   clear()          — write `{components: []}`
 *   patch(p, value)  — sugar over setState("/canvas" + p, value)
 *
 * `append` reads from the bridge's mirror rather than asking the
 * frontend, so it works pre-`ready` (boot-time extension code) and stays
 * consistent under concurrent handler dispatches on different tabs.
 */
export interface CanvasComponent {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

export interface CanvasMutationResult {
  ok: boolean;
  error?: string;
}

export interface CanvasApi {
  emit(components: CanvasComponent | CanvasComponent[]): Promise<CanvasMutationResult>;
  append(components: CanvasComponent | CanvasComponent[]): Promise<CanvasMutationResult>;
  clear(): Promise<CanvasMutationResult>;
  patch(subpath: string, value: unknown): Promise<CanvasMutationResult>;
}

export interface CanvasDeps {
  /**
   * Tab-aware setState. Mirrors the bridge's `_setState(path, value, sourceTabId?)`.
   * The factory always passes `boundTabId` as `sourceTabId` so attribution
   * is explicit; pass `undefined` to defer to ALS / active-tab fallback.
   */
  setState: (
    path: string,
    value: unknown,
    sourceTabId: string | undefined,
  ) => Promise<CanvasMutationResult>;
  /**
   * Returns the currently-attributed tab when no explicit id was given.
   * The bridge wires this to `tabContext.getStore() ?? currentAgentTabId`.
   * Used only by `append` to decide which tab's mirrored canvas to read.
   */
  resolveAttributedTab: (explicitTabId: string | undefined) => string | undefined;
  /** Returns the components currently mirrored at `/canvas` for the tab, or `[]`. */
  readCanvasComponents: (tabId: string | undefined) => CanvasComponent[];
}

export function normalizeCanvasComponents(input: unknown): CanvasComponent[] {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr.filter(
    (c): c is CanvasComponent =>
      !!c &&
      typeof c === "object" &&
      typeof (c as { type?: unknown }).type === "string" &&
      (c as { type: string }).type.length > 0,
  );
}

export function readCanvasComponentsFromTabState(
  tabState: Record<string, unknown> | undefined,
): CanvasComponent[] {
  if (!tabState) return [];
  const canvas = tabState.canvas as { components?: unknown } | undefined;
  const components = canvas?.components;
  return Array.isArray(components)
    ? (components.filter(
        (c) => !!c && typeof c === "object",
      ) as CanvasComponent[])
    : [];
}

/**
 * Build a canvas API bound to a specific tab (or to the floating
 * "active tab" when `boundTabId` is undefined). The bridge calls this
 * once per handler dispatch (binding to the originating tabId) and
 * once at boot for the global `aethon.canvas` (binding to undefined,
 * so writes flow through the same ALS / active-tab fallback that
 * `setState(path, value)` uses).
 */
export function makeCanvasApi(
  boundTabId: string | undefined,
  deps: CanvasDeps,
): CanvasApi {
  return {
    emit(components) {
      const list = normalizeCanvasComponents(components);
      return deps.setState("/canvas", { components: list }, boundTabId);
    },
    append(components) {
      const additions = normalizeCanvasComponents(components);
      if (additions.length === 0) return Promise.resolve({ ok: true });
      const attributedTab = deps.resolveAttributedTab(boundTabId);
      const existing = deps.readCanvasComponents(attributedTab);
      return deps.setState(
        "/canvas",
        { components: [...existing, ...additions] },
        boundTabId,
      );
    },
    clear() {
      return deps.setState("/canvas", { components: [] }, boundTabId);
    },
    patch(subpath, value) {
      if (typeof subpath !== "string" || subpath.length === 0) {
        return Promise.resolve({ ok: false, error: "subpath required" });
      }
      const normalized = subpath.startsWith("/") ? subpath : "/" + subpath;
      return deps.setState("/canvas" + normalized, value, boundTabId);
    },
  };
}
