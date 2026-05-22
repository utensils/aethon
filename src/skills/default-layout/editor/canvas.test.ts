import { describe, expect, it } from "vitest";

import { compressPath } from "./path";

describe("compressPath", () => {
  it("compresses POSIX paths to the last two components", () => {
    expect(compressPath("/Users/me/project/src/App.tsx")).toBe("…/src/App.tsx");
  });

  it("compresses Windows paths to the last two components", () => {
    expect(compressPath("C:\\Users\\me\\project\\src\\App.tsx")).toBe(
      "…/src/App.tsx",
    );
  });
});
