import { describe, expect, it } from "vitest";
import { shouldReloadForHmrPayload } from "./hmr";

describe("shouldReloadForHmrPayload", () => {
  it("allows css-only hot updates to stay in place", () => {
    expect(
      shouldReloadForHmrPayload({
        updates: [{ type: "css-update" }, { type: "css-update" }],
      }),
    ).toBe(false);
  });

  it("reloads for js updates so app shell state is rebuilt", () => {
    expect(
      shouldReloadForHmrPayload({
        updates: [{ type: "css-update" }, { type: "js-update" }],
      }),
    ).toBe(true);
  });

  it("reloads on unknown payloads", () => {
    expect(shouldReloadForHmrPayload(undefined)).toBe(true);
    expect(shouldReloadForHmrPayload({})).toBe(true);
  });
});
