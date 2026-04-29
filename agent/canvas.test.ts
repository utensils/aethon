import { describe, expect, it, beforeEach } from "vitest";
import {
  makeCanvasApi,
  normalizeCanvasComponents,
  readCanvasComponentsFromTabState,
  type CanvasComponent,
  type CanvasMutationResult,
} from "./canvas";
import { setAtPointer } from "./jsonPointer";

interface SetStateCall {
  path: string;
  value: unknown;
  sourceTabId: string | undefined;
}

interface Harness {
  calls: SetStateCall[];
  /**
   * Per-tab mirror — keyed by tabId, value is the bridge's view of what
   * was last written. Each setState fold-merges the path/value into this
   * map (only `/canvas` paths matter for these tests, so we just track
   * the canvas slot).
   */
  mirror: Map<string, { canvas?: { components?: CanvasComponent[] } }>;
  attributedTab: string | undefined;
  api: ReturnType<typeof makeCanvasApi>;
}

function newHarness(opts: {
  attributedTab?: string;
  initialMirror?: Record<string, { canvas?: { components?: CanvasComponent[] } }>;
  setStateResult?: CanvasMutationResult;
} = {}): Harness {
  const calls: SetStateCall[] = [];
  const mirror = new Map<string, { canvas?: { components?: CanvasComponent[] } }>();
  if (opts.initialMirror) {
    for (const [k, v] of Object.entries(opts.initialMirror)) mirror.set(k, v);
  }
  // The bridge's resolver always returns a real tab id ("default" is
  // its baseline); reproduce that here so makeCanvasApi's CanvasDeps
  // contract holds in tests too.
  const fallbackTab = opts.attributedTab ?? "default";
  const harness: Harness = {
    calls,
    mirror,
    attributedTab: fallbackTab,
    api: makeCanvasApi(undefined, {
      setState: (path, value, sourceTabId) => {
        calls.push({ path, value, sourceTabId });
        const tabId = sourceTabId ?? fallbackTab;
        if (path === "/canvas") {
          mirror.set(tabId, { canvas: value });
        }
        return Promise.resolve(opts.setStateResult ?? { ok: true });
      },
      resolveAttributedTab: (explicit) => explicit ?? fallbackTab,
      readCanvasComponents: (tabId) =>
        readCanvasComponentsFromTabState(mirror.get(tabId)),
    }),
  };
  return harness;
}

describe("normalizeCanvasComponents", () => {
  it("wraps a single component into an array", () => {
    const c: CanvasComponent = { type: "card", props: { title: "x" } };
    expect(normalizeCanvasComponents(c)).toEqual([c]);
  });

  it("returns a fresh array with valid entries kept in order", () => {
    const a: CanvasComponent = { type: "card" };
    const b: CanvasComponent = { type: "text" };
    expect(normalizeCanvasComponents([a, b])).toEqual([a, b]);
  });

  it("filters out null / non-objects / typeless entries", () => {
    const valid: CanvasComponent = { type: "card" };
    expect(
      normalizeCanvasComponents([
        valid,
        null,
        undefined,
        "string",
        42,
        { props: { foo: 1 } }, // missing type
        { type: "" }, // empty type
      ]),
    ).toEqual([valid]);
  });

  it("returns an empty array for null / undefined input", () => {
    expect(normalizeCanvasComponents(null)).toEqual([]);
    expect(normalizeCanvasComponents(undefined)).toEqual([]);
  });
});

describe("readCanvasComponentsFromTabState", () => {
  it("returns empty when tab state is missing", () => {
    expect(readCanvasComponentsFromTabState(undefined)).toEqual([]);
  });

  it("returns empty when canvas slot is unset", () => {
    expect(readCanvasComponentsFromTabState({})).toEqual([]);
  });

  it("returns the components array verbatim when present", () => {
    const c: CanvasComponent = { type: "card" };
    expect(
      readCanvasComponentsFromTabState({ canvas: { components: [c] } }),
    ).toEqual([c]);
  });

  it("filters non-object entries inside components", () => {
    const c: CanvasComponent = { type: "card" };
    expect(
      readCanvasComponentsFromTabState({
        canvas: { components: [c, null, "junk", 42] as unknown[] },
      }),
    ).toEqual([c]);
  });
});

describe("makeCanvasApi.emit", () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness({ attributedTab: "tab-1" });
  });

  it("writes /canvas with a {components: [...]} envelope", async () => {
    const c: CanvasComponent = { type: "card", props: { title: "hi" } };
    const r = await h.api.emit(c);
    expect(r).toEqual({ ok: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      path: "/canvas",
      value: { components: [c] },
      sourceTabId: "tab-1",
    });
  });

  it("accepts an array of components", async () => {
    const c1: CanvasComponent = { type: "card" };
    const c2: CanvasComponent = { type: "text" };
    await h.api.emit([c1, c2]);
    expect(h.calls[0].value).toEqual({ components: [c1, c2] });
  });

  it("emits with an empty components array when given an empty list", async () => {
    await h.api.emit([]);
    expect(h.calls[0].value).toEqual({ components: [] });
  });
});

describe("makeCanvasApi.append", () => {
  it("reads existing components and appends new ones", async () => {
    const existing: CanvasComponent = { type: "card", id: "old" };
    const h = newHarness({
      attributedTab: "tab-1",
      initialMirror: { "tab-1": { canvas: { components: [existing] } } },
    });
    const fresh: CanvasComponent = { type: "text", id: "new" };
    await h.api.append(fresh);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].value).toEqual({ components: [existing, fresh] });
  });

  it("falls back to emit-equivalent when the canvas is empty", async () => {
    const h = newHarness({ attributedTab: "tab-1" });
    const c: CanvasComponent = { type: "card" };
    await h.api.append(c);
    expect(h.calls[0].value).toEqual({ components: [c] });
  });

  it("is a no-op (returns ok) when given zero valid components", async () => {
    const h = newHarness({ attributedTab: "tab-1" });
    const r = await h.api.append([]);
    expect(r).toEqual({ ok: true });
    expect(h.calls).toHaveLength(0);
  });

  it("filters invalid entries before appending", async () => {
    const h = newHarness({ attributedTab: "tab-1" });
    const c: CanvasComponent = { type: "card" };
    // The runtime helper is defensive against null entries and typeless
    // / empty-type objects; those wouldn't compile through the normal
    // `CanvasComponent[]` signature, so push them in as `unknown` first
    // and let the runtime filter strip them.
    const inputs: unknown[] = [c, null, { type: "" }];
    await h.api.append(inputs as CanvasComponent[]);
    expect(h.calls[0].value).toEqual({ components: [c] });
  });

  it("does not see other tabs' canvas state under concurrent dispatches", async () => {
    const onTab1: CanvasComponent = { type: "card", id: "tab1-existing" };
    const onTab2: CanvasComponent = { type: "card", id: "tab2-existing" };
    const h = newHarness({
      attributedTab: "tab-1",
      initialMirror: {
        "tab-1": { canvas: { components: [onTab1] } },
        "tab-2": { canvas: { components: [onTab2] } },
      },
    });
    // Bind to tab-2 explicitly — append should read tab-2's mirror, not tab-1's.
    const tab2Api = makeCanvasApi("tab-2", {
      setState: (path, value, sourceTabId) => {
        h.calls.push({ path, value, sourceTabId });
        return Promise.resolve({ ok: true });
      },
      resolveAttributedTab: (explicit) => explicit ?? "tab-1",
      readCanvasComponents: (id) => readCanvasComponentsFromTabState(h.mirror.get(id)),
    });
    const fresh: CanvasComponent = { type: "text", id: "fresh" };
    await tab2Api.append(fresh);
    expect(h.calls[0].sourceTabId).toBe("tab-2");
    expect(h.calls[0].value).toEqual({ components: [onTab2, fresh] });
  });
});

describe("makeCanvasApi.clear", () => {
  it("writes /canvas with an empty components array", async () => {
    const h = newHarness({ attributedTab: "tab-1" });
    await h.api.clear();
    expect(h.calls[0]).toEqual({
      path: "/canvas",
      value: { components: [] },
      sourceTabId: "tab-1",
    });
  });
});

describe("makeCanvasApi.patch", () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness({ attributedTab: "tab-1" });
  });

  it("prefixes /canvas to the subpath", async () => {
    await h.api.patch("/components/0/props/title", "hello");
    expect(h.calls[0]).toEqual({
      path: "/canvas/components/0/props/title",
      value: "hello",
      sourceTabId: "tab-1",
    });
  });

  it("accepts subpaths without a leading slash", async () => {
    await h.api.patch("components/0/props/title", "hello");
    expect(h.calls[0].path).toBe("/canvas/components/0/props/title");
  });

  it("rejects empty / non-string subpath without calling setState", async () => {
    const r1 = await h.api.patch("", "x");
    const r2 = await h.api.patch(42 as unknown as string, "x");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});

describe("makeCanvasApi tab attribution", () => {
  it("forwards the resolved tab id as sourceTabId on every write", async () => {
    const h = newHarness();
    const api = makeCanvasApi("tab-bound", {
      setState: (path, value, sourceTabId) => {
        h.calls.push({ path, value, sourceTabId });
        return Promise.resolve({ ok: true });
      },
      resolveAttributedTab: (explicit) => explicit ?? "tab-active",
      readCanvasComponents: () => [],
    });
    await api.emit({ type: "card" });
    await api.append({ type: "text" });
    await api.clear();
    await api.patch("/foo", 1);
    expect(h.calls.map((c) => c.sourceTabId)).toEqual([
      "tab-bound",
      "tab-bound",
      "tab-bound",
      "tab-bound",
    ]);
  });

  it("global variant (boundTabId undefined) attributes to the resolver's fallback", async () => {
    // Bridge's contract: resolveAttributedTab always returns a real
    // tab id (falling back to "default" when no ALS / active tab).
    // The global aethon.canvas helper picks that up so writes always
    // attribute to a tab — never to the global state tree.
    const calls: SetStateCall[] = [];
    const seen: (string | undefined)[] = [];
    const existing: CanvasComponent = { type: "card", id: "from-default" };
    const api = makeCanvasApi(undefined, {
      setState: (path, value, sourceTabId) => {
        calls.push({ path, value, sourceTabId });
        return Promise.resolve({ ok: true });
      },
      resolveAttributedTab: (explicit) => {
        seen.push(explicit);
        return explicit ?? "default";
      },
      readCanvasComponents: (id) =>
        id === "default" ? [existing] : [],
    });
    await api.append({ type: "text", id: "new" });
    expect(seen).toEqual([undefined]);
    expect(calls[0].value).toEqual({
      components: [existing, { type: "text", id: "new" }],
    });
    expect(calls[0].sourceTabId).toBe("default");
  });
});

describe("makeCanvasApi emit + patch + append", () => {
  it("preserves the components array across patch and survives a follow-up append", async () => {
    // Wires the harness through the real bridge-side `setAtPointer` so
    // a `canvas.patch` write at /canvas/components/0/... folds into the
    // mirror without flattening the array. Regression: previously the
    // mirror used a spread-only writer that turned `[c1]` into `{0: c1}`,
    // so the next `canvas.append` saw "no array" and dropped the
    // existing component.
    const calls: SetStateCall[] = [];
    let mirror: Record<string, unknown> = {};
    const api = makeCanvasApi("tab-1", {
      setState: (path, value, sourceTabId) => {
        calls.push({ path, value, sourceTabId });
        mirror = setAtPointer(mirror, path, value);
        return Promise.resolve({ ok: true });
      },
      resolveAttributedTab: (explicit) => explicit ?? "tab-1",
      readCanvasComponents: () => readCanvasComponentsFromTabState(mirror),
    });
    const c1: CanvasComponent = {
      id: "indexing",
      type: "card",
      props: { title: "Indexing", state: "running" },
    };
    await api.emit(c1);
    await api.patch("/components/0/props/state", "ok");
    const c2: CanvasComponent = { id: "next", type: "card", props: { title: "Done" } };
    await api.append(c2);
    // Mirror still has an array — not the regressed `{0: ..., 1: ...}` shape.
    const components = (
      (mirror.canvas as { components?: unknown }).components
    );
    expect(Array.isArray(components)).toBe(true);
    expect(components).toHaveLength(2);
    expect((components as { props: { state: string } }[])[0].props.state).toBe(
      "ok",
    );
    expect((components as { id: string }[])[1].id).toBe("next");
  });
});

describe("makeCanvasApi.append boot-time fallback", () => {
  it("attributes boot writes to the resolver's default tab and survives sequential appends", async () => {
    // Mirrors the bridge's boot-time wiring: with no ALS / active tab,
    // resolveAttributedTab returns the canonical default tab so the
    // write lands in that tab's per-tab mirror (which the frontend
    // replays on `ready`). The reader and the writer agree on the same
    // tab id, so two sequential appends compose instead of clobbering.
    const calls: SetStateCall[] = [];
    const mirror = new Map<string, { canvas?: { components?: CanvasComponent[] } }>();
    const api = makeCanvasApi(undefined, {
      setState: (path, value, sourceTabId) => {
        calls.push({ path, value, sourceTabId });
        if (path === "/canvas" && sourceTabId) {
          mirror.set(sourceTabId, { canvas: value });
        }
        return Promise.resolve({ ok: true });
      },
      resolveAttributedTab: (explicit) => explicit ?? "default",
      readCanvasComponents: (id) =>
        readCanvasComponentsFromTabState(mirror.get(id)),
    });
    const c1: CanvasComponent = { type: "card", id: "first" };
    const c2: CanvasComponent = { type: "card", id: "second" };
    await api.append(c1);
    await api.append(c2);
    expect(calls).toHaveLength(2);
    // Both writes attribute to "default" rather than the global tree.
    expect(calls[0].sourceTabId).toBe("default");
    expect(calls[1].sourceTabId).toBe("default");
    // The second append composes with the first.
    expect(calls[1].value).toEqual({ components: [c1, c2] });
  });
});

describe("makeCanvasApi error propagation", () => {
  it("propagates setState failure through emit", async () => {
    const api = makeCanvasApi(undefined, {
      setState: () => Promise.resolve({ ok: false, error: "frontend_rejected: oops" }),
      resolveAttributedTab: () => "default",
      readCanvasComponents: () => [],
    });
    const r = await api.emit({ type: "card" });
    expect(r).toEqual({ ok: false, error: "frontend_rejected: oops" });
  });
});
