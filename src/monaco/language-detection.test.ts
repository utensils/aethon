import { describe, expect, it } from "vitest";
import { EDITOR_LANGUAGE_IDS, languageFromPath } from "./language-detection";

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
    expect(languageFromPath("Makefile")).toBe("make");
    expect(languageFromPath("project/CMakeLists.txt")).toBe("cmake");
    expect(languageFromPath(".vimrc")).toBe("viml");
    expect(languageFromPath("nginx.conf")).toBe("nginx");
  });

  it("maps the expanded language set (nix/toml/ruby and friends)", () => {
    expect(languageFromPath("flake.nix")).toBe("nix");
    expect(languageFromPath("Cargo.toml")).toBe("toml");
    expect(languageFromPath("lib/widget.rb")).toBe("ruby");
    expect(languageFromPath("main.tf")).toBe("terraform");
    expect(languageFromPath("app.ex")).toBe("elixir");
    expect(languageFromPath("Component.vue")).toBe("vue");
    expect(languageFromPath("schema.prisma")).toBe("prisma");
    expect(languageFromPath("deploy.ps1")).toBe("powershell");
    expect(languageFromPath("Contract.sol")).toBe("solidity");
    expect(languageFromPath("config.toml")).toBe("toml");
  });

  it("exposes every resolvable id (sans plaintext) for Monaco registration", () => {
    // The set drives `registerEditorLanguages`; nix + toml must be in it
    // or the editor would fall back to plaintext for them.
    expect(EDITOR_LANGUAGE_IDS).toContain("nix");
    expect(EDITOR_LANGUAGE_IDS).toContain("toml");
    expect(EDITOR_LANGUAGE_IDS).toContain("ruby");
    expect(EDITOR_LANGUAGE_IDS).not.toContain("plaintext");
    // No duplicates.
    expect(EDITOR_LANGUAGE_IDS.length).toBe(new Set(EDITOR_LANGUAGE_IDS).size);
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
