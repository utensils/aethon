import { describe, expect, it } from "vitest";
import { languageFromPath } from "./language-detection";

describe("languageFromPath", () => {
  it("maps common source extensions to Monaco language ids", () => {
    expect(languageFromPath("src/App.tsx")).toBe("typescript");
    expect(languageFromPath("src/utils/highlight.ts")).toBe("typescript");
    expect(languageFromPath("scripts/build.mjs")).toBe("javascript");
    expect(languageFromPath("server.py")).toBe("python");
    expect(languageFromPath("Cargo.toml")).toBe("toml");
  });

  it("handles absolute paths the same as relative", () => {
    expect(languageFromPath("/home/user/project/src/main.rs")).toBe("rust");
    expect(languageFromPath("C:\\proj\\foo.cs")).toBe("csharp");
  });

  it("recognises filename-keyed fallbacks", () => {
    // Dockerfile has no extension but should still resolve.
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("docker/Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("Makefile")).toBe("shell");
  });

  it("falls back to plaintext for unknown / missing extensions", () => {
    expect(languageFromPath("README")).toBe("plaintext");
    expect(languageFromPath("file.")).toBe("plaintext");
    expect(languageFromPath("file.unknownext")).toBe("plaintext");
    expect(languageFromPath("")).toBe("plaintext");
  });

  it("is case-insensitive on the extension", () => {
    expect(languageFromPath("Main.JS")).toBe("javascript");
    expect(languageFromPath("schema.SQL")).toBe("sql");
  });
});
