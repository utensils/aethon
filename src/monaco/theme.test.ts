import { describe, expect, it, vi } from "vitest";

// Stub the Monaco setup module before the SUT imports it — the test
// environment has no DOM Worker, so importing the real setup pulls in
// every Monaco language worker and explodes.
vi.mock("./setup", () => ({
  monaco: {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
  },
}));

import { monacoThemeFor, applyMonacoTheme } from "./theme";
import { monaco } from "./setup";

describe("monacoThemeFor", () => {
  it("returns the namespaced aethon id for each builtin theme", () => {
    expect(monacoThemeFor("ember")).toBe("aethon-ember");
    expect(monacoThemeFor("aether")).toBe("aethon-aether");
    expect(monacoThemeFor("brink")).toBe("aethon-brink");
    expect(monacoThemeFor("paper")).toBe("aethon-paper");
  });

  it("falls back to a stable default for null/undefined", () => {
    // null/undefined are treated as dark — default to ember.
    expect(monacoThemeFor(undefined)).toBe("aethon-ember");
    expect(monacoThemeFor(null)).toBe("aethon-ember");
  });
});

describe("applyMonacoTheme", () => {
  it("synthesizes + activates the per-theme Monaco theme", () => {
    applyMonacoTheme("brink");
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      "aethon-brink",
      expect.objectContaining({
        base: "vs-dark",
        inherit: true,
        colors: expect.any(Object),
      }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("aethon-brink");
  });

  it("falls back to a built-in theme when defineTheme throws", () => {
    (monaco.editor.defineTheme as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("not initialised");
      },
    );
    expect(() => applyMonacoTheme("paper")).not.toThrow();
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("vs");
  });
});
