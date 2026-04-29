/**
 * Programmatic canvas push API — sugar over `setState("/canvas", ...)`.
 *
 * Extracted from `agent/main.ts` so it has a unit-test surface without
 * spinning up the full bridge. The factory takes `setState` and a
 * per-tab canvas reader as plain dependencies; the bridge wires them to
 * its real `_setState` and per-tab mirror lookups. Pure module — no I/O,
 * no globals, no shared state.
 *
 * The four operations:
 *   emit(c | c[])    — replace `/canvas` with `{components: [...]}`
 *   append(c | c[])  — read existing components, push new ones, write back
 *   clear()          — write `{components: []}`
 *   patch(p, value)  — sugar over setState("/canvas" + p, value)
 *
 * Trade-off vs plain `aethon.setState("/canvas", ...)`:
 *   The canvas helper ALWAYS attributes writes to a concrete tab id —
 *   the bridge's resolver falls back through ALS → currentAgentTab →
 *   frontend-active-tab → "default" so attribution is locked at call
 *   time. Plain setState lets the frontend resolve the active tab at
 *   apply time when no tabId is sent, which is fine for fire-and-forget
 *   single writes but races for compose-on-read patterns like `append`
 *   (the bridge can't know which tab to read from if attribution is
 *   deferred). Locking attribution lets two synchronous appends compose
 *   deterministically, at the cost of subtly differing semantics from
 *   plain setState for tab-less code paths.
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
   * Tab-aware setState. Mirrors the bridge's `_setState(path, value, sourceTabId)`.
   * The canvas helper ALWAYS passes a concrete tab id so the bridge's
   * per-tab mirror stays authoritative for `append` reads.
   */
  setState: (
    path: string,
    value: unknown,
    sourceTabId: string,
  ) => Promise<CanvasMutationResult>;
  /**
   * Always returns a real tab id — never undefined. Bridge wires:
   *   explicit ?? ALS ?? currentAgentTabId
   *     ?? frontendActiveTabId() ?? "default"
   * "default" is the canonical pre-created tab so boot-time writes
   * (no frontend, no ALS, no active turn) still land somewhere real.
   */
  resolveTab: (explicitTabId: string | undefined) => string;
  /**
   * Returns the components mirrored at `/canvas` for the given tab.
   * Implementations should consult per-tab state first, then fall back
   * to the bridge's tab-less retained canvas (extensionStateTree.canvas)
   * so a canvas seeded by plain `aethon.setState("/canvas", ...)` is
   * still composable. Either source represents "what's currently on
   * screen" — preferring the per-tab record when both exist.
   */
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
 * so writes flow through the resolver's full priority chain).
 */
export function makeCanvasApi(
  boundTabId: string | undefined,
  deps: CanvasDeps,
): CanvasApi {
  // Resolve at call time (not construction) so the global helper picks
  // up the live active turn / frontend-active tab on every write.
  const resolve = (): string => deps.resolveTab(boundTabId);
  return {
    emit(components) {
      const list = normalizeCanvasComponents(components);
      return deps.setState("/canvas", { components: list }, resolve());
    },
    append(components) {
      const additions = normalizeCanvasComponents(components);
      if (additions.length === 0) return Promise.resolve({ ok: true });
      const tab = resolve();
      const existing = deps.readCanvasComponents(tab);
      return deps.setState(
        "/canvas",
        { components: [...existing, ...additions] },
        tab,
      );
    },
    clear() {
      return deps.setState("/canvas", { components: [] }, resolve());
    },
    patch(subpath, value) {
      if (typeof subpath !== "string" || subpath.length === 0) {
        return Promise.resolve({ ok: false, error: "subpath required" });
      }
      const normalized = subpath.startsWith("/") ? subpath : "/" + subpath;
      return deps.setState("/canvas" + normalized, value, resolve());
    },
  };
}
