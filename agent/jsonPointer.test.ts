import { describe, expect, it } from "vitest";
import { setAtPointer } from "./jsonPointer";

describe("setAtPointer", () => {
  it("returns the input unchanged for empty / root pointers", () => {
    const before = { a: 1 };
    expect(setAtPointer(before, "", 42)).toBe(before);
    expect(setAtPointer(before, "/", 42)).toBe(before);
  });

  it("creates intermediate objects on demand", () => {
    expect(setAtPointer({}, "/foo/bar/baz", 42)).toEqual({
      foo: { bar: { baz: 42 } },
    });
  });

  it("preserves arrays under nested writes", () => {
    const before = {
      canvas: {
        components: [
          { id: "a", type: "card", props: { title: "old" } },
          { id: "b", type: "text" },
        ],
      },
    };
    const after = setAtPointer(
      before,
      "/canvas/components/0/props/title",
      "new",
    );
    // The bug this guards against: spreading an array as `{...arr}`
    // turns it into a plain object `{0: ..., 1: ...}`. Components must
    // remain an Array.
    const components = (after.canvas as { components: unknown }).components;
    expect(Array.isArray(components)).toBe(true);
    expect(components).toHaveLength(2);
    expect(
      ((components as { props: { title: string } }[])[0]).props.title,
    ).toBe("new");
    // Untouched siblings keep their identity-equal references where possible.
    expect((components as unknown[])[1]).toBe(before.canvas.components[1]);
  });

  it("does not mutate the input root", () => {
    const before = { canvas: { components: [{ id: "a", type: "card" }] } };
    setAtPointer(before, "/canvas/components/0/type", "text");
    // Original tree intact.
    expect(before.canvas.components[0].type).toBe("card");
  });

  it("decodes ~1 and ~0 escapes in tokens", () => {
    const after = setAtPointer({}, "/a~1b/c~0d", 1);
    expect(after).toEqual({ "a/b": { "c~d": 1 } });
  });

  it("writes through a leading existing array index", () => {
    const before = { items: [10, 20, 30] };
    const after = setAtPointer(before, "/items/1", 99);
    expect(Array.isArray(after.items)).toBe(true);
    expect(after.items).toEqual([10, 99, 30]);
  });

  it("creates arrays for missing intermediates when next token is numeric", () => {
    // Mirrors the frontend's setPointer: writing /canvas/components/0/type
    // against an empty tree should produce {canvas: {components: [{type:"x"}]}}
    // — components must be an Array, not {0: {...}}.
    const after = setAtPointer({}, "/canvas/components/0/type", "card");
    expect(after).toEqual({
      canvas: { components: [{ type: "card" }] },
    });
    expect(
      Array.isArray((after.canvas as { components: unknown }).components),
    ).toBe(true);
  });

  it("creates objects for missing intermediates when next token is non-numeric", () => {
    const after = setAtPointer({}, "/canvas/meta/title", "x");
    expect(after).toEqual({ canvas: { meta: { title: "x" } } });
    expect(
      Array.isArray((after.canvas as { meta: unknown }).meta),
    ).toBe(false);
  });

  it("rebuilds an array as an array even when intermediate clone uses spread", () => {
    // A subtle case: write at a deep index path, ensuring every
    // intermediate Array is cloned with [...arr] not {...arr}.
    const before = {
      a: [
        { id: 0, items: [{ value: 1 }] },
        { id: 1, items: [{ value: 2 }] },
      ],
    };
    const after = setAtPointer(before, "/a/1/items/0/value", 99);
    expect(Array.isArray(after.a)).toBe(true);
    const a1 = (after.a as { items: { value: number }[] }[])[1];
    expect(Array.isArray(a1.items)).toBe(true);
    expect(a1.items[0].value).toBe(99);
  });
});
