import { describe, expect, it } from "vitest";
import { resolveBoolean, resolveNumber, resolveString } from "./dataBinding";

const state = { name: "World", count: 7, on: true, miss: undefined };

describe("resolveString", () => {
  it("returns string literals verbatim", () => {
    expect(resolveString("hi", state)).toBe("hi");
  });

  it("dereferences a {$ref} to a string", () => {
    expect(resolveString({ $ref: "/name" }, state)).toBe("World");
  });

  it("coerces non-string ref values via String()", () => {
    expect(resolveString({ $ref: "/count" }, state)).toBe("7");
    expect(resolveString({ $ref: "/on" }, state)).toBe("true");
  });

  it("returns empty string when the ref doesn't resolve", () => {
    expect(resolveString({ $ref: "/missing" }, state)).toBe("");
  });
});

describe("resolveNumber", () => {
  it("returns number literals verbatim", () => {
    expect(resolveNumber(3, state)).toBe(3);
  });

  it("dereferences a {$ref} to a number", () => {
    expect(resolveNumber({ $ref: "/count" }, state)).toBe(7);
  });

  it("returns 0 when the ref is undefined", () => {
    expect(resolveNumber({ $ref: "/missing" }, state)).toBe(0);
  });

  it("coerces a numeric string via Number()", () => {
    expect(resolveNumber({ $ref: "/n" }, { n: "42" })).toBe(42);
  });
});

describe("resolveBoolean", () => {
  it("returns boolean literals verbatim", () => {
    expect(resolveBoolean(true, state)).toBe(true);
    expect(resolveBoolean(false, state)).toBe(false);
  });

  it("dereferences a {$ref} to a boolean", () => {
    expect(resolveBoolean({ $ref: "/on" }, state)).toBe(true);
  });

  it("treats undefined/null/0/'' as false", () => {
    expect(resolveBoolean({ $ref: "/missing" }, state)).toBe(false);
    expect(resolveBoolean({ $ref: "/n" }, { n: 0 })).toBe(false);
  });

  it("treats any truthy value as true", () => {
    expect(resolveBoolean({ $ref: "/n" }, { n: "x" })).toBe(true);
    expect(resolveBoolean({ $ref: "/n" }, { n: 1 })).toBe(true);
  });
});
