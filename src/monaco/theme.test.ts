import { describe, expect, it, vi } from "vitest";

// Stub the Monaco setup module before the SUT imports it — the test
// environment has no DOM Worker, so importing the real setup pulls in
// every Monaco language worker and explodes.
vi.mock("./setup", () => ({
  monaco: {
    editor: {
      setTheme: vi.fn(),
    },
  },
}));

import { monacoThemeFor, applyMonacoTheme } from "./theme";
import { monaco } from "./setup";

describe("monacoThemeFor", () => {
  it("maps known dark themes to vs-dark", () => {
    expect(monacoThemeFor("ember")).toBe("vs-dark");
    expect(monacoThemeFor("aether")).toBe("vs-dark");
    expect(monacoThemeFor("brink")).toBe("vs-dark");
  });

  it("maps light themes to vs", () => {
    expect(monacoThemeFor("paper")).toBe("vs");
  });

  it("defaults to vs-dark for null/undefined/unknown", () => {
    expect(monacoThemeFor(undefined)).toBe("vs-dark");
    expect(monacoThemeFor(null)).toBe("vs-dark");
    expect(monacoThemeFor("unknown")).toBe("vs");
  });
});

describe("applyMonacoTheme", () => {
  it("forwards to monaco.editor.setTheme with the mapped id", () => {
    applyMonacoTheme("paper");
    expect(monaco.editor.setTheme).toHaveBeenCalledWith("vs");
    applyMonacoTheme("ember");
    expect(monaco.editor.setTheme).toHaveBeenCalledWith("vs-dark");
  });

  it("swallows errors from setTheme so a pre-mount call is harmless", () => {
    (monaco.editor.setTheme as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("not initialised");
    });
    expect(() => applyMonacoTheme("ember")).not.toThrow();
  });
});
