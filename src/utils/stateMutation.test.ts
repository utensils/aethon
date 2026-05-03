import { describe, expect, it } from "vitest";
import {
  decodeToken,
  deepMergeState,
  isPlainObject,
  layoutPatch,
} from "./stateMutation";

describe("decodeToken", () => {
  it("unescapes ~1 to /", () => {
    expect(decodeToken("foo~1bar")).toBe("foo/bar");
  });
  it("unescapes ~0 to ~", () => {
    expect(decodeToken("foo~0bar")).toBe("foo~bar");
  });
  it("applies ~1 before ~0 collisions", () => {
    expect(decodeToken("~01")).toBe("~1");
  });
  it("returns input unchanged when no escapes", () => {
    expect(decodeToken("plain")).toBe("plain");
  });
});

describe("layoutPatch", () => {
  it("returns input when pointer empty or root", () => {
    const obj = { a: 1 };
    expect(layoutPatch(obj, "", 9)).toBe(obj);
    expect(layoutPatch(obj, "/", 9)).toBe(obj);
  });

  it("sets a top-level field", () => {
    const out = layoutPatch({ a: 1, b: 2 }, "/a", 99);
    expect(out).toEqual({ a: 99, b: 2 });
  });

  it("preserves arrays as arrays through the path", () => {
    const payload = { components: [{ id: "x" }, { id: "y" }] };
    const out = layoutPatch(payload, "/components/1/id", "Y2");
    expect(Array.isArray(out.components)).toBe(true);
    expect(out.components[1]).toEqual({ id: "Y2" });
    expect(out.components[0]).toEqual({ id: "x" });
  });

  it("does not mutate the input", () => {
    const payload = { components: [{ id: "x" }] };
    const out = layoutPatch(payload, "/components/0/id", "X2");
    expect(payload.components[0].id).toBe("x");
    expect(out.components[0].id).toBe("X2");
  });

  it("creates intermediate objects when path missing", () => {
    const out = layoutPatch<Record<string, unknown>>({}, "/a/b/c", 7);
    expect(out).toEqual({ a: { b: { c: 7 } } });
  });

  it("decodes escape sequences in keys", () => {
    const out = layoutPatch({}, "/foo~1bar/baz", 1);
    expect(out).toEqual({ "foo/bar": { baz: 1 } });
  });
});

describe("isPlainObject", () => {
  it("is true for object literals", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });
  it("is false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
  });
  it("is false for null and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject("s")).toBe(false);
  });
  it("is false for class instances", () => {
    class K {}
    expect(isPlainObject(new K())).toBe(false);
  });
});

describe("deepMergeState", () => {
  it("merges plain objects recursively", () => {
    const out = deepMergeState({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } });
    expect(out).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it("replaces arrays rather than merging", () => {
    const out = deepMergeState({ a: [1, 2, 3] }, { a: [9] });
    expect(out).toEqual({ a: [9] });
  });

  it("replaces primitives", () => {
    expect(deepMergeState({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("does not mutate target", () => {
    const target = { a: { b: 1 } };
    deepMergeState(target, { a: { b: 2 } });
    expect(target.a.b).toBe(1);
  });

  it("treats class instance as primitive replacement", () => {
    class K {}
    const k = new K();
    const out = deepMergeState({ a: { b: 1 } }, { a: k });
    expect(out.a).toBe(k);
  });
});
