import { describe, expect, it, beforeEach, vi } from "vitest";

// shiki.ts imports `monaco-editor` directly (it needs the real namespace
// at runtime for the `shikiToMonaco` binding). In the test environment we
// stub it down to just the `languages` surface `registerEditorLanguages`
// touches — importing the real package pulls in DOM workers and explodes.
const registered: string[] = [];
let known: { id: string }[] = [];

vi.mock("monaco-editor", () => ({
  languages: {
    getLanguages: () => known,
    register: (lang: { id: string }) => {
      registered.push(lang.id);
      known.push(lang);
    },
  },
}));

// `shikiToMonaco` + `createHighlighter` are only exercised by the async
// path; stub them so the module loads without the WASM engine.
vi.mock("@shikijs/monaco", () => ({ shikiToMonaco: vi.fn() }));
vi.mock("shiki", () => ({ createHighlighter: vi.fn() }));

import { registerEditorLanguages, __testing } from "./shiki";

beforeEach(() => {
  registered.length = 0;
  known = [];
  __testing.reset();
});

describe("registerEditorLanguages", () => {
  it("registers toml and nix (the ids Monaco's basic-languages omits)", () => {
    registerEditorLanguages();
    expect(registered).toContain("toml");
    expect(registered).toContain("nix");
    expect(registered).toContain("ruby");
  });

  it("does not re-register ids Monaco already knows", () => {
    known = [{ id: "toml" }];
    registerEditorLanguages();
    expect(registered).not.toContain("toml");
    // …but still registers the ones Monaco lacks.
    expect(registered).toContain("nix");
  });

  it("is idempotent across repeated calls", () => {
    registerEditorLanguages();
    const first = registered.length;
    registerEditorLanguages();
    expect(registered.length).toBe(first);
  });
});
