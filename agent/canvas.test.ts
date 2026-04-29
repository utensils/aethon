import { describe, expect, it, beforeEach } from "vitest";
import {
  makeCanvasApi,
  normalizeCanvasComponents,
  readCanvasComponentsFromTabState,
  type CanvasComponent,
  type CanvasMutationResult,
  type CanvasDeps,
} from "./canvas";
import { setAtPointer } from "./jsonPointer";

interface SetStateCall {
  path: string;
  value: unknown;
  sourceTabId: string;
}

/**
 * Build a deps object backed by an in-memory per-tab mirror that
 * mimics the bridge's perTabExtState. setState records every call AND
 * folds the write into the mirror under sourceTabId — so a follow-up
 * append composes correctly. resolveTab returns a configurable
 * fallback (default "default") so tests can model the various
 * attribution regimes without re-implementing the resolver.
 */
function makeTestDeps(opts: {
  fallbackTab?: string;
  setStateResult?: CanvasMutationResult;
  initialMirror?: Record<string, { canvas?: { components?: CanvasComponent[] } }>;
} = {}): {
  deps: CanvasDeps;
  calls: SetStateCall[];
  mirror: Map<string, Record<string, unknown>>;
} {
  const fallbackTab = opts.fallbackTab ?? "default";
  const calls: SetStateCall[] = [];
  const mirror = new Map<string, Record<string, unknown>>();
  if (opts.initialMirror) {
    for (const [k, v] of Object.entries(opts.initialMirror)) {
      mirror.set(k, v);
    }
  }
  const deps: CanvasDeps = {
    setState: (path, value, sourceTabId) => {
      calls.push({ path, value, sourceTabId });
      const before = mirror.get(sourceTabId) ?? {};
      mirror.set(sourceTabId, setAtPointer(before, path, value));
      return Promise.resolve(opts.setStateResult ?? { ok: true });
    },
    resolveTab: (explicit) => explicit ?? fallbackTab,
    readCanvasComponents: (tabId) =>
      readCanvasComponentsFromTabState(mirror.get(tabId)),
  };
  return { deps, calls, mirror };
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

  it("filters null / non-objects / typeless entries", () => {
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

  it("returns [] for null / undefined input", () => {
    expect(normalizeCanvasComponents(null)).toEqual([]);
    expect(normalizeCanvasComponents(undefined)).toEqual([]);
  });
});

describe("readCanvasComponentsFromTabState", () => {
  it("returns [] when tab state is missing", () => {
    expect(readCanvasComponentsFromTabState(undefined)).toEqual([]);
  });

  it("returns [] when canvas slot is unset", () => {
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
  it("writes /canvas with a {components: [...]} envelope", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const c: CanvasComponent = { type: "card", props: { title: "hi" } };
    const r = await api.emit(c);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([
      { path: "/canvas", value: { components: [c] }, sourceTabId: "tab-1" },
    ]);
  });

  it("accepts an array of components", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const c1: CanvasComponent = { type: "card" };
    const c2: CanvasComponent = { type: "text" };
    await api.emit([c1, c2]);
    expect(calls[0].value).toEqual({ components: [c1, c2] });
  });

  it("emits with an empty components array when given an empty list", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    await api.emit([]);
    expect(calls[0].value).toEqual({ components: [] });
  });
});

describe("makeCanvasApi.append", () => {
  it("reads existing components and composes new ones", async () => {
    const existing: CanvasComponent = { type: "card", id: "old" };
    const { deps, calls } = makeTestDeps({
      fallbackTab: "tab-1",
      initialMirror: { "tab-1": { canvas: { components: [existing] } } },
    });
    const api = makeCanvasApi(undefined, deps);
    const fresh: CanvasComponent = { type: "text", id: "new" };
    await api.append(fresh);
    expect(calls).toHaveLength(1);
    expect(calls[0].value).toEqual({ components: [existing, fresh] });
  });

  it("falls back to emit-equivalent when canvas is empty", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const c: CanvasComponent = { type: "card" };
    await api.append(c);
    expect(calls[0].value).toEqual({ components: [c] });
  });

  it("is a no-op (returns ok) when given zero valid components", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const r = await api.append([]);
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("does not see other tabs' canvas state under concurrent dispatches", async () => {
    const onTab1: CanvasComponent = { type: "card", id: "tab1-existing" };
    const onTab2: CanvasComponent = { type: "card", id: "tab2-existing" };
    const { deps, calls } = makeTestDeps({
      fallbackTab: "tab-1",
      initialMirror: {
        "tab-1": { canvas: { components: [onTab1] } },
        "tab-2": { canvas: { components: [onTab2] } },
      },
    });
    // Bind to tab-2 explicitly — append must read tab-2's mirror.
    const tab2Api = makeCanvasApi("tab-2", deps);
    const fresh: CanvasComponent = { type: "text", id: "fresh" };
    await tab2Api.append(fresh);
    expect(calls[0].sourceTabId).toBe("tab-2");
    expect(calls[0].value).toEqual({ components: [onTab2, fresh] });
  });

  it("composes synchronous fire-and-forget appends via the in-memory mirror", async () => {
    // Two appends in the same tick without awaiting. The mirror is
    // updated synchronously inside setState, so the second read sees
    // the first write.
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const c1: CanvasComponent = { type: "card", id: "first" };
    const c2: CanvasComponent = { type: "card", id: "second" };
    await Promise.all([api.append(c1), api.append(c2)]);
    expect(calls).toHaveLength(2);
    expect(calls[1].value).toEqual({ components: [c1, c2] });
  });
});

describe("makeCanvasApi.clear", () => {
  it("writes /canvas with an empty components array", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    await api.clear();
    expect(calls[0]).toEqual({
      path: "/canvas",
      value: { components: [] },
      sourceTabId: "tab-1",
    });
  });
});

describe("makeCanvasApi.patch", () => {
  let deps: CanvasDeps;
  let calls: SetStateCall[];
  beforeEach(() => {
    const harness = makeTestDeps({ fallbackTab: "tab-1" });
    deps = harness.deps;
    calls = harness.calls;
  });

  it("prefixes /canvas to the subpath", async () => {
    const api = makeCanvasApi(undefined, deps);
    await api.patch("/components/0/props/title", "hello");
    expect(calls[0]).toEqual({
      path: "/canvas/components/0/props/title",
      value: "hello",
      sourceTabId: "tab-1",
    });
  });

  it("accepts subpaths without a leading slash", async () => {
    const api = makeCanvasApi(undefined, deps);
    await api.patch("components/0/props/title", "hello");
    expect(calls[0].path).toBe("/canvas/components/0/props/title");
  });

  it("rejects empty / non-string subpath without calling setState", async () => {
    const api = makeCanvasApi(undefined, deps);
    const r1 = await api.patch("", "x");
    const r2 = await api.patch(42 as unknown as string, "x");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("makeCanvasApi tab attribution", () => {
  it("forwards boundTabId as sourceTabId on every write", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-active" });
    const api = makeCanvasApi("tab-bound", deps);
    await api.emit({ type: "card" });
    await api.append({ type: "text" });
    await api.clear();
    await api.patch("/foo", 1);
    expect(calls.map((c) => c.sourceTabId)).toEqual([
      "tab-bound",
      "tab-bound",
      "tab-bound",
      "tab-bound",
    ]);
  });

  it("global helper falls back to resolver's default when nothing is bound", async () => {
    const { deps, calls } = makeTestDeps({ fallbackTab: "default" });
    const api = makeCanvasApi(undefined, deps);
    await api.emit({ type: "card" });
    expect(calls[0].sourceTabId).toBe("default");
  });
});

describe("makeCanvasApi emit + patch + append", () => {
  it("preserves the components array across patch and survives a follow-up append", async () => {
    // Wires the harness through the real bridge-side `setAtPointer` so
    // a `canvas.patch` write at /canvas/components/0/... folds into the
    // mirror without flattening the array. Regression: the original
    // setAtPointer used object spread which turned `[c1]` into
    // `{0: c1}`, so the next `canvas.append` saw "no array" and dropped
    // the existing component.
    const { deps, calls } = makeTestDeps({ fallbackTab: "tab-1" });
    const api = makeCanvasApi(undefined, deps);
    const c1: CanvasComponent = {
      id: "indexing",
      type: "card",
      props: { title: "Indexing", state: "running" },
    };
    await api.emit(c1);
    await api.patch("/components/0/props/state", "ok");
    const c2: CanvasComponent = { id: "next", type: "card", props: { title: "Done" } };
    await api.append(c2);
    expect(calls).toHaveLength(3);
    // The append's read sees [{state: "ok"}, ...], not [{state: "running"}].
    const composed = calls[2].value as { components: { props: { state: string }; id: string }[] };
    expect(composed.components).toHaveLength(2);
    expect(composed.components[0].props.state).toBe("ok");
    expect(composed.components[1].id).toBe("next");
  });
});

describe("makeCanvasApi tab-less seed fallback", () => {
  it("uses the bridge's tab-less retained canvas when per-tab mirror is empty", async () => {
    // Models the case codex flagged: an extension calls plain
    // aethon.setState("/canvas", ...) without a tab context, which
    // routes to extensionStateTree on the bridge. canvas.append should
    // see THAT seed and compose with it, not replace the visible canvas
    // with only the appended component.
    const seeded: CanvasComponent = { type: "card", id: "seeded-via-setState" };
    const calls: SetStateCall[] = [];
    const perTab = new Map<string, Record<string, unknown>>();
    const tablessRetained: Record<string, unknown> = {
      canvas: { components: [seeded] },
    };
    const deps: CanvasDeps = {
      setState: (path, value, sourceTabId) => {
        calls.push({ path, value, sourceTabId });
        const before = perTab.get(sourceTabId) ?? {};
        perTab.set(sourceTabId, setAtPointer(before, path, value));
        return Promise.resolve({ ok: true });
      },
      resolveTab: (explicit) => explicit ?? "active",
      readCanvasComponents: (id) => {
        const fromTab = readCanvasComponentsFromTabState(perTab.get(id));
        if (fromTab.length > 0) return fromTab;
        return readCanvasComponentsFromTabState(tablessRetained);
      },
    };
    const api = makeCanvasApi(undefined, deps);
    const fresh: CanvasComponent = { type: "text", id: "appended" };
    await api.append(fresh);
    expect(calls[0].value).toEqual({
      components: [seeded, fresh],
    });
  });
});

describe("makeCanvasApi error propagation", () => {
  it("propagates setState failure through emit", async () => {
    const deps: CanvasDeps = {
      setState: () => Promise.resolve({ ok: false, error: "frontend_rejected: oops" }),
      resolveTab: () => "default",
      readCanvasComponents: () => [],
    };
    const api = makeCanvasApi(undefined, deps);
    const r = await api.emit({ type: "card" });
    expect(r).toEqual({ ok: false, error: "frontend_rejected: oops" });
  });
});
