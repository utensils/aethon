import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  effectiveLayout,
  getLayout,
  getLayoutSlots,
  listLayouts,
  patchLayout,
  patchLayoutTree,
  registerLayout,
  setLayout,
  summarizeLayout,
  summarizeLayoutStructure,
  unregisterLayout,
} from "./layout-manager";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  let writes = 0;
  return {
    state,
    sent,
    deps: {
      send: (m: Record<string, unknown>) => sent.push(m),
      scheduleStateFileWrite: () => {
        writes += 1;
      },
    },
    writes: () => writes,
  };
}

describe("patchLayoutTree", () => {
  it("replaces a leaf at a JSON Pointer path", () => {
    const tree = { a: { b: { c: 1 } } };
    const patched = patchLayoutTree(tree, "/a/b/c", 42) as typeof tree;
    expect(patched.a.b.c).toBe(42);
    // Original is untouched (immutable patch).
    expect(tree.a.b.c).toBe(1);
  });

  it("preserves arrays via index keys", () => {
    const tree = { items: [{ x: 1 }, { x: 2 }, { x: 3 }] };
    const patched = patchLayoutTree(tree, "/items/1/x", 99) as typeof tree;
    expect(patched.items[1].x).toBe(99);
    expect(patched.items[0].x).toBe(1);
    expect(Array.isArray(patched.items)).toBe(true);
  });

  it("materializes missing numeric branches as arrays", () => {
    expect(patchLayoutTree({}, "/items/0/x", 1)).toEqual({
      items: [{ x: 1 }],
    });
  });

  it("decodes ~0/~1 escapes per RFC 6901", () => {
    const tree = { "a/b": { "~c": 1 } };
    const patched = patchLayoutTree(tree, "/a~1b/~0c", 42) as Record<
      string,
      Record<string, number>
    >;
    expect(patched["a/b"]["~c"]).toBe(42);
  });

  it("empty / root pointer returns input unchanged", () => {
    const tree = { a: 1 };
    expect(patchLayoutTree(tree, "", 9)).toBe(tree);
    expect(patchLayoutTree(tree, "/", 9)).toBe(tree);
  });
});

describe("setLayout", () => {
  it("rejects non-objects", async () => {
    const f = makeFixture();
    const r = await setLayout(f.state, f.deps, null);
    expect(r.ok).toBe(false);
  });

  it("stores the payload and clears pending patches", async () => {
    const f = makeFixture();
    f.state.pendingLayoutPatches = [{ path: "/x", value: 1 }];
    await setLayout(f.state, f.deps, { components: [{ id: "root" }] });
    expect(f.state.extensionLayout).toEqual({
      components: [{ id: "root" }],
    });
    expect(f.state.pendingLayoutPatches).toEqual([]);
    expect(f.sent[0]).toMatchObject({ type: "layout_set" });
    expect(f.writes()).toBe(1);
  });
});

describe("patchLayout", () => {
  it("queues against pendingLayoutPatches when no extensionLayout exists", async () => {
    const f = makeFixture();
    await patchLayout(f.state, f.deps, "/components/0", { id: "x" });
    expect(f.state.pendingLayoutPatches).toEqual([
      { path: "/components/0", value: { id: "x" } },
    ]);
    expect(f.sent[0]).toMatchObject({ type: "layout_patch" });
  });

  it("folds into extensionLayout when one is set", async () => {
    const f = makeFixture();
    f.state.extensionLayout = { a: { b: 1 } };
    await patchLayout(f.state, f.deps, "/a/b", 9);
    expect(f.state.extensionLayout).toEqual({ a: { b: 9 } });
    // Did not push to pending.
    expect(f.state.pendingLayoutPatches).toEqual([]);
  });

  it("rejects empty path", async () => {
    const f = makeFixture();
    const r = await patchLayout(f.state, f.deps, "", 1);
    expect(r.ok).toBe(false);
  });
});

describe("registerLayout", () => {
  it("rejects bad shapes", async () => {
    const f = makeFixture();
    expect(
      (await registerLayout(f.state, f.deps, null)).ok,
    ).toBe(false);
    expect(
      (await registerLayout(f.state, f.deps, { id: "1bad" })).ok,
    ).toBe(false);
    expect(
      (await registerLayout(f.state, f.deps, { id: "ok", name: "" })).ok,
    ).toBe(false);
    expect(
      (
        await registerLayout(f.state, f.deps, { id: "ok", name: "n" })
      ).ok,
    ).toBe(false);
  });

  it("rejects reserved built-in ids", async () => {
    const f = makeFixture();
    const r = await registerLayout(f.state, f.deps, {
      id: "workstation",
      name: "X",
      payload: { components: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("registers a layout, emits extension_layouts, and writes state file", async () => {
    const f = makeFixture();
    await registerLayout(f.state, f.deps, {
      id: "studio",
      name: "Studio",
      description: "experiment",
      payload: { components: [{ id: "root", type: "layout" }] },
    });
    expect(f.state.extensionLayouts.get("studio")).toMatchObject({
      id: "studio",
      name: "Studio",
      description: "experiment",
    });
    expect(f.sent[0]).toMatchObject({ type: "extension_layouts" });
    expect(f.writes()).toBe(1);
  });
});

describe("unregisterLayout", () => {
  it("rejects empty id", async () => {
    const f = makeFixture();
    expect((await unregisterLayout(f.state, f.deps, "")).ok).toBe(false);
  });

  it("returns 'not a registered layout' on miss", async () => {
    const f = makeFixture();
    expect((await unregisterLayout(f.state, f.deps, "nope")).ok).toBe(false);
  });

  it("removes a registered layout and emits extension_layouts", async () => {
    const f = makeFixture();
    await registerLayout(f.state, f.deps, {
      id: "x",
      name: "X",
      payload: { components: [] },
    });
    f.sent.length = 0;
    const r = await unregisterLayout(f.state, f.deps, "x");
    expect(r.ok).toBe(true);
    expect(f.state.extensionLayouts.has("x")).toBe(false);
    expect(f.sent[0]).toMatchObject({
      type: "extension_layouts",
      layouts: [],
    });
  });
});

describe("listLayouts + getLayout + getLayoutSlots", () => {
  it("listLayouts returns metadata (no payload)", async () => {
    const f = makeFixture();
    await registerLayout(f.state, f.deps, {
      id: "x",
      name: "X",
      payload: { components: [] },
    });
    expect(listLayouts(f.state)).toEqual([{ id: "x", name: "X" }]);
  });

  it("getLayout returns null when nothing is loaded", () => {
    const f = makeFixture();
    expect(getLayout(f.state)).toBeNull();
  });

  it("getLayout returns extensionLayout when set", () => {
    const f = makeFixture();
    f.state.extensionLayout = { components: [{ id: "x" }] };
    expect(getLayout(f.state)).toEqual({ components: [{ id: "x" }] });
  });

  it("getLayout folds pending patches into bootLayout", () => {
    const f = makeFixture();
    f.state.bootLayout = { a: 1 };
    f.state.pendingLayoutPatches = [{ path: "/a", value: 99 }];
    expect(getLayout(f.state)).toEqual({ a: 99 });
  });

  it("getLayoutSlots returns the cached catalogue or null", () => {
    const f = makeFixture();
    expect(getLayoutSlots(f.state)).toBeNull();
    f.state.layoutSlotsCatalogue = {
      version: 1,
      description: "test",
      slots: {},
    };
    expect(getLayoutSlots(f.state)?.version).toBe(1);
  });
});

describe("effectiveLayout", () => {
  it("matches getLayout (single source of truth)", () => {
    const f = makeFixture();
    expect(effectiveLayout(f.state)).toBeNull();
    f.state.bootLayout = { x: 1 };
    expect(effectiveLayout(f.state)).toEqual({ x: 1 });
  });
});

describe("summarizeLayout", () => {
  it("describes the boot tree when no extension layout", () => {
    const f = makeFixture();
    f.state.bootLayout = {
      components: [
        {
          type: "grid",
          props: { columns: "240px 1fr", areas: ["sidebar canvas"] },
        },
      ],
    };
    expect(summarizeLayout(f.state)).toContain("default-layout");
    expect(summarizeLayout(f.state)).toContain("sidebar=left");
  });

  it("describes a setLayout override", () => {
    const f = makeFixture();
    f.state.extensionLayout = {
      components: [
        {
          type: "grid",
          props: { columns: "1fr 240px", areas: ["canvas sidebar"] },
        },
      ],
    };
    expect(summarizeLayout(f.state)).toContain("extension layout (setLayout)");
    expect(summarizeLayout(f.state)).toContain("sidebar=right");
  });

  it("returns 'unknown layout' when no boot tree is loaded", () => {
    const f = makeFixture();
    expect(summarizeLayout(f.state)).toContain("unknown layout");
  });
});

describe("summarizeLayoutStructure", () => {
  it("returns null when no layout known", () => {
    const f = makeFixture();
    expect(summarizeLayoutStructure(f.state)).toBeNull();
  });

  it("flattens children into id/type/area entries", () => {
    const f = makeFixture();
    f.state.bootLayout = {
      components: [
        {
          id: "root",
          type: "grid",
          props: { columns: "1fr", areas: ["a"] },
          children: [
            { id: "child", type: "card", props: { area: "a" } },
          ],
        },
      ],
    };
    const summary = summarizeLayoutStructure(f.state);
    expect(summary).toMatchObject({
      rootId: "root",
      rootType: "grid",
      columns: "1fr",
      areas: ["a"],
      children: [{ id: "child", type: "card", area: "a" }],
    });
  });
});
