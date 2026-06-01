import { describe, expect, it } from "vitest";
import {
  deletePointer,
  isDynamicRef,
  resolvePointer,
  resolveValue,
  setPointer,
} from "./jsonPointer";

describe("resolvePointer", () => {
  const state = {
    a: { b: { c: 1 } },
    list: [10, 20, 30],
    "weird~slash/key": "raw",
  };

  it("returns the whole state for empty pointer", () => {
    expect(resolvePointer(state, "")).toBe(state);
    expect(resolvePointer(state, "/")).toBe(state);
  });

  it("walks nested objects", () => {
    expect(resolvePointer(state, "/a/b/c")).toBe(1);
  });

  it("indexes into arrays via numeric tokens", () => {
    expect(resolvePointer(state, "/list/0")).toBe(10);
    expect(resolvePointer(state, "/list/2")).toBe(30);
  });

  it("returns undefined when the path doesn't resolve", () => {
    expect(resolvePointer(state, "/a/missing/c")).toBeUndefined();
    expect(resolvePointer(state, "/list/99")).toBeUndefined();
  });

  it("decodes RFC 6901 escapes (~0 = ~, ~1 = /)", () => {
    expect(resolvePointer(state, "/weird~0slash~1key")).toBe("raw");
  });

  it("returns undefined when descending through a primitive", () => {
    expect(resolvePointer({ x: 5 }, "/x/y")).toBeUndefined();
  });

  it("returns undefined for malformed non-string pointers", () => {
    expect(resolvePointer(state, 42)).toBeUndefined();
    expect(resolvePointer(state, { $ref: "/a/b/c" })).toBeUndefined();
  });
});

describe("setPointer", () => {
  it("returns a new object — does not mutate", () => {
    const before = { a: { b: 1 } };
    const after = setPointer(before, "/a/b", 2);
    expect(before.a.b).toBe(1);
    expect(after.a).not.toBe(before.a);
    expect((after.a as { b: number }).b).toBe(2);
  });

  it("creates intermediate objects on missing paths", () => {
    const after = setPointer({}, "/a/b/c", 7);
    expect(after).toEqual({ a: { b: { c: 7 } } });
  });

  it("preserves siblings outside the write path", () => {
    const before = { a: { x: 1, y: 2 } };
    const after = setPointer(before, "/a/y", 99);
    expect(after).toEqual({ a: { x: 1, y: 99 } });
  });

  it("preserves arrays when patching through them", () => {
    const before = {
      canvas: {
        components: [
          { id: "progress", type: "card", props: { title: "Starting" } },
        ],
      },
    };
    const after = setPointer(
      before,
      "/canvas/components/0/props/title",
      "Streaming",
    );

    expect(Array.isArray((after.canvas as { components: unknown }).components)).toBe(true);
    expect(after).toEqual({
      canvas: {
        components: [
          { id: "progress", type: "card", props: { title: "Streaming" } },
        ],
      },
    });
    expect(before.canvas.components[0].props.title).toBe("Starting");
  });

  it("creates arrays for missing numeric path segments", () => {
    const after = setPointer({}, "/canvas/components/0/type", "card");
    expect(after).toEqual({ canvas: { components: [{ type: "card" }] } });
    expect(Array.isArray((after.canvas as { components: unknown }).components)).toBe(true);
  });

  it("returns the original ref for empty pointers", () => {
    const before = { a: 1 };
    expect(setPointer(before, "", 9)).toBe(before);
    expect(setPointer(before, "/", 9)).toBe(before);
  });
});

describe("deletePointer", () => {
  it("removes a leaf key without mutating input", () => {
    const before = { a: { b: 1, c: 2 } };
    const after = deletePointer(before, "/a/b");
    expect(before).toEqual({ a: { b: 1, c: 2 } });
    expect(after).toEqual({ a: { c: 2 } });
  });

  it("removes a top-level key", () => {
    const after = deletePointer({ a: 1, b: 2 }, "/a");
    expect(after).toEqual({ b: 2 });
  });

  it("returns the same reference when the path doesn't exist (no allocation)", () => {
    const before = { a: 1 };
    const after = deletePointer(before, "/missing/nested");
    expect(after).toBe(before);
  });

  it("does NOT prune empty intermediate objects", () => {
    // Documented behavior — leaves the parent shape intact.
    const after = deletePointer({ a: { b: 1 } }, "/a/b");
    expect(after).toEqual({ a: {} });
  });

  it("preserves arrays when deleting a nested key through them", () => {
    const before = {
      canvas: {
        components: [
          { id: "progress", type: "card", props: { title: "Streaming" } },
        ],
      },
    };
    const after = deletePointer(before, "/canvas/components/0/props/title");
    expect(after).toEqual({
      canvas: {
        components: [
          { id: "progress", type: "card", props: {} },
        ],
      },
    });
    expect(Array.isArray((after.canvas as { components: unknown }).components)).toBe(true);
    expect(before.canvas.components[0].props.title).toBe("Streaming");
  });

  it("removes array elements by index", () => {
    const after = deletePointer({ items: ["a", "b", "c"] }, "/items/1");
    expect(after).toEqual({ items: ["a", "c"] });
  });

  it("returns the input when pointer is empty", () => {
    const before = { a: 1 };
    expect(deletePointer(before, "")).toBe(before);
    expect(deletePointer(before, "/")).toBe(before);
  });

  it("decodes RFC 6901 escapes when locating the key", () => {
    const before = { "a/b": 1, c: 2 };
    const after = deletePointer(before, "/a~1b");
    expect(after).toEqual({ c: 2 });
  });
});

describe("isDynamicRef + resolveValue", () => {
  it("recognizes {$ref} objects", () => {
    expect(isDynamicRef({ $ref: "/x" })).toBe(true);
    expect(isDynamicRef({ ref: "/x" })).toBe(false);
    expect(isDynamicRef({ $ref: 42 })).toBe(false);
    expect(isDynamicRef("/x")).toBe(false);
    expect(isDynamicRef(null)).toBe(false);
  });

  it("returns the static value when not a $ref", () => {
    expect(resolveValue("hello", {})).toBe("hello");
    expect(resolveValue(42, {})).toBe(42);
  });

  it("dereferences {$ref} via resolvePointer", () => {
    expect(resolveValue({ $ref: "/x/y" }, { x: { y: "deep" } })).toBe("deep");
  });
});
