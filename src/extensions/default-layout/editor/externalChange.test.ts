import { describe, expect, it } from "vitest";

import {
  decideExternalChange,
  parentDir,
  payloadAffectsFile,
} from "./externalChange";

describe("parentDir", () => {
  it("returns the containing directory", () => {
    expect(parentDir("/repo/src/App.tsx")).toBe("/repo/src");
  });
  it("handles backslashes", () => {
    expect(parentDir("C:\\repo\\src\\App.tsx")).toBe("C:\\repo\\src");
  });
  it("returns empty for a bare name", () => {
    expect(parentDir("App.tsx")).toBe("");
  });
});

describe("payloadAffectsFile", () => {
  const root = "/repo";
  const file = "/repo/src/App.tsx";

  it("matches when the file's parent dir changed", () => {
    expect(
      payloadAffectsFile({ root, dirs: ["/repo/src"] }, root, file),
    ).toBe(true);
  });

  it("matches when the file path itself is reported", () => {
    expect(
      payloadAffectsFile({ root, dirs: ["/repo/src/App.tsx"] }, root, file),
    ).toBe(true);
  });

  it("ignores changes in unrelated dirs", () => {
    expect(
      payloadAffectsFile({ root, dirs: ["/repo/test"] }, root, file),
    ).toBe(false);
  });

  it("ignores a different project root", () => {
    expect(
      payloadAffectsFile({ root: "/other", dirs: ["/repo/src"] }, root, file),
    ).toBe(false);
  });

  it("is false without a file or root", () => {
    expect(payloadAffectsFile({ root, dirs: ["/repo/src"] }, "", file)).toBe(
      false,
    );
    expect(payloadAffectsFile({ root, dirs: ["/repo/src"] }, root, "")).toBe(
      false,
    );
  });
});

describe("decideExternalChange", () => {
  it("does nothing when the mtime is not newer", () => {
    expect(decideExternalChange(100, 100, false)).toBe("none");
    expect(decideExternalChange(90, 100, true)).toBe("none");
  });
  it("reloads a clean buffer when newer", () => {
    expect(decideExternalChange(200, 100, false)).toBe("reload");
  });
  it("flags a dirty buffer when newer", () => {
    expect(decideExternalChange(200, 100, true)).toBe("flag");
  });
});
