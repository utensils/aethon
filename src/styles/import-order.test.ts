import { describe, expect, it } from "vitest";

import { readStyleFile } from "./css-test-utils";

const expectedChromeImports = [
  "./chrome/base.css",
  "./chrome/layout.css",
  "./chrome/sidebar.css",
  "./chrome/header.css",
  "./chrome/chat.css",
  "./chrome/terminal.css",
  "./chrome/overlays.css",
  "./chrome/tools.css",
  "./chrome/editor.css",
  "./chrome/dashboard.css",
  "./chrome/vcs.css",
  "./chrome/transitions.css",
  "./chrome/composer.css",
  "./chrome/subagents.css",
];

describe("stylesheet import order", () => {
  it("loads fonts, shape tokens, theme tokens, then chrome rules from mainApp", () => {
    const mainApp = readStyleFile("../mainApp.tsx");
    const styleImports = [...mainApp.matchAll(/import\s+["']\.\/styles\/([^"']+)["'];/g)].map(
      (match) => match[1],
    );

    // fonts first: self-hosted @font-face declarations must be in the
    // sheet before tokens.css names the families.
    expect(styleImports).toEqual([
      "fonts",
      "tokens.css",
      "themes.css",
      "chrome.css",
    ]);
  });

  it("keeps chrome domain imports in original cascade order", () => {
    const chromeEntry = readStyleFile("chrome.css");
    const imports = [...chromeEntry.matchAll(/@import\s+["']([^"']+)["'];/g)].map(
      (match) => match[1],
    );

    expect(imports).toEqual(expectedChromeImports);
  });
});
