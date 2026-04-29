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
   * The factory passes `writeTab` — usually the concrete attribution,
   * but `undefined` for post-ready tab-less code so the frontend
   * resolves to the user's currently-active tab.
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
  /**
   * Sync the bridge's per-tab mirror under `tabId` for the predicted
   * read scope, even when the outbound `setState` was tab-less. Without
   * this, post-ready tab-less appends would each see an empty `readTab`
   * and replace prior canvas content instead of composing it. Bridge
   * implementation writes to `perTabExtState[tabId]` directly.
   *
   * Called after the outbound setState resolves. The factory only
   * invokes it when `writeTab !== readTab` — the cases where the
   * setState write itself wouldn't have updated `readTab`'s mirror.
   */
  syncMirror: (tabId: string, path: string, value: unknown) => void;
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
  // Wraps a setState call so post-ready tab-less writes still update
  // the bridge's per-tab mirror under the predicted read scope. When
  // `writeTab === readTab` (or both undefined) the underlying setState
  // already syncs the right mirror, so this is a no-op via the equality
  // check.
  async function dispatch(
    tabs: CanvasResolution,
    path: string,
    value: unknown,
  ): Promise<CanvasMutationResult> {
    const result = await deps.setState(path, value, tabs.writeTab);
    if (result.ok && tabs.writeTab !== tabs.readTab) {
      deps.syncMirror(tabs.readTab, path, value);
    }
    return result;
  }
  return {
    emit(components) {
      const list = normalizeCanvasComponents(components);
      return dispatch(resolve(), "/canvas", { components: list });
    },
    append(components) {
      const additions = normalizeCanvasComponents(components);
      if (additions.length === 0) return Promise.resolve({ ok: true });
      const tabs = resolve();
      const existing = deps.readCanvasComponents(tabs.readTab);
      return dispatch(tabs, "/canvas", {
        components: [...existing, ...additions],
      });
    },
    clear() {
      return dispatch(resolve(), "/canvas", { components: [] });
    },
    patch(subpath, value) {
      if (typeof subpath !== "string" || subpath.length === 0) {
        return Promise.resolve({ ok: false, error: "subpath required" });
      }
      const normalized = subpath.startsWith("/") ? subpath : "/" + subpath;
      return dispatch(resolve(), "/canvas" + normalized, value);
    },
  };
}
