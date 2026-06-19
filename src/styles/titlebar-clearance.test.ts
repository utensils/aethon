// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { fileURLToPath } from "node:url";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "chrome.css"), "utf8");

describe("macOS overlay titlebar clearance", () => {
  it("reserves traffic-light space in the header when the sidebar is collapsed", () => {
    expect(css).toMatch(
      /\[data-platform="mac"\]\[data-sidebar-collapsed="true"\]\s+\.app-header\s*\{[\s\S]*?padding-left:\s*94px\s*!important/,
    );
    expect(css).not.toMatch(/:has\(/);
  });
});
