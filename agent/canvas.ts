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

export interface CanvasResolution {
  /**
   * Tab id sent on the outbound state_patch (`sourceTabId` to setState).
   * `undefined` lets the frontend route the patch to whichever tab is
   * currently active — matching plain `aethon.setState` semantics for
   * tab-less writes (e.g. an extension's setInterval after startup).
   */
  writeTab: string | undefined;
  /**
   * Tab id whose mirrored canvas `append` should read from. Always a
   * concrete id so the bridge can predict where the upcoming write will
   * land — pre-ready, "default" (the canonical pre-created tab);
   * post-ready, the frontend-active tab id (read from frontendState's
   * /tabs slice), falling back to "default".
   */
  readTab: string;
}

export interface CanvasDeps {
  /**
   * Tab-aware setState. Mirrors the bridge's `_setState(path, value, sourceTabId?)`.
   * The factory passes `writeTab` from `resolveTabs(...)` — usually the
   * concrete attribution, but `undefined` for post-ready tab-less code
   * so the frontend resolves to the user's currently-active tab.
   */
  setState: (
    path: string,
    value: unknown,
    sourceTabId: string | undefined,
  ) => Promise<CanvasMutationResult>;
  /**
   * Resolve write attribution + read scope for one canvas call. Split so
   * tab-less post-ready writes can omit attribution (matching setState's
   * "frontend routes to active") while `append` still has a concrete tab
   * id to read existing components from.
   */
  resolveTabs: (explicitTabId: string | undefined) => CanvasResolution;
  /** Returns the components currently mirrored at `/canvas` for the tab, or `[]`. */
  readCanvasComponents: (tabId: string) => CanvasComponent[];
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
  // Resolve at call time (not construction) so the global helper picks
  // up the live active turn / frontend-active tab on every write.
  const resolve = (): CanvasResolution => deps.resolveTabs(boundTabId);
  return {
    emit(components) {
      const list = normalizeCanvasComponents(components);
      return deps.setState("/canvas", { components: list }, resolve().writeTab);
    },
    append(components) {
      const additions = normalizeCanvasComponents(components);
      if (additions.length === 0) return Promise.resolve({ ok: true });
      const tabs = resolve();
      const existing = deps.readCanvasComponents(tabs.readTab);
      return deps.setState(
        "/canvas",
        { components: [...existing, ...additions] },
        tabs.writeTab,
      );
    },
    clear() {
      return deps.setState("/canvas", { components: [] }, resolve().writeTab);
    },
    patch(subpath, value) {
      if (typeof subpath !== "string" || subpath.length === 0) {
        return Promise.resolve({ ok: false, error: "subpath required" });
      }
      const normalized = subpath.startsWith("/") ? subpath : "/" + subpath;
      return deps.setState("/canvas" + normalized, value, resolve().writeTab);
    },
  };
}
