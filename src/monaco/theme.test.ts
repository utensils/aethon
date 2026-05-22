import { describe, expect, it, beforeEach, vi } from "vitest";

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

import {
  monacoThemeFor,
  applyMonacoTheme,
  registerMonacoTheme,
  __testing,
} from "./theme";
import { monaco } from "./setup";

beforeEach(() => {
  (monaco.editor.defineTheme as ReturnType<typeof vi.fn>).mockReset();
  (monaco.editor.setTheme as ReturnType<typeof vi.fn>).mockReset();
  __testing.reset();
});

describe("monacoThemeFor", () => {
  it("returns the namespaced aethon id for each builtin theme", () => {
    expect(monacoThemeFor("ember")).toBe("aethon-ember");
    expect(monacoThemeFor("aether")).toBe("aethon-aether");
    expect(monacoThemeFor("brink")).toBe("aethon-brink");
    expect(monacoThemeFor("paper")).toBe("aethon-paper");
  });

  it("falls back to ember for null/undefined", () => {
    expect(monacoThemeFor(undefined)).toBe("aethon-ember");
    expect(monacoThemeFor(null)).toBe("aethon-ember");
  });
});

describe("applyMonacoTheme", () => {
  it("seeds + activates each built-in by id", () => {
    applyMonacoTheme("brink");
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      "aethon-brink",
      expect.objectContaining({
        base: "vs-dark",
        inherit: false,
        colors: expect.any(Object),
        rules: expect.arrayContaining([
          expect.objectContaining({
            token: "keyword",
            foreground: "f9cc6c",
          }),
        ]),
      }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("aethon-brink");
  });

  it("paper resolves to a light base", () => {
    applyMonacoTheme("paper");
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      "aethon-paper",
      expect.objectContaining({
        base: "vs",
        colors: expect.objectContaining({
          "editor.background": "#fef3e2",
        }),
        rules: expect.arrayContaining([
          expect.objectContaining({
            token: "keyword",
            foreground: "b94000",
          }),
        ]),
      }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("aethon-paper");
  });

  it("falls back to a built-in theme when setTheme throws", () => {
    (monaco.editor.setTheme as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("not initialised");
    });
    expect(() => applyMonacoTheme("paper")).not.toThrow();
    // After the catch the helper retries with the matching built-in.
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("vs");
  });
});

describe("registerMonacoTheme", () => {
  it("registers an override + applies it when the id is active", () => {
    const data: monaco.editor.IStandaloneThemeData = {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: { "editor.background": "#000000" },
    };
    registerMonacoTheme("custom", data);
    // defineTheme is called eagerly at register time.
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      "aethon-custom",
      data,
    );
    // And again when applyMonacoTheme picks it up.
    applyMonacoTheme("custom");
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("aethon-custom");
  });

  it("ignores malformed input rather than throwing", () => {
    expect(() => registerMonacoTheme("", { base: "vs", inherit: true, rules: [], colors: {} })).not.toThrow();
    expect(() => registerMonacoTheme("ok", null as unknown as monaco.editor.IStandaloneThemeData)).not.toThrow();
  });
});
