// @ts-nocheck

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, "tokens.css"), "utf8");
const chromeCss = readFileSync(join(here, "chrome.css"), "utf8");


function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

describe("scrollbar sizing CSS", () => {
  it("uses one slim token for native and xterm scrollbars", () => {
    expect(tokensCss).toMatch(/--scrollbar-size:\s*4px;/);
    expect(tokensCss).not.toMatch(/--webkit-scrollbar-size/);

    const webkitBody = cssRuleBody(chromeCss, "*::-webkit-scrollbar");
    expect(webkitBody).toMatch(/width:\s*var\(--scrollbar-size\);/);
    expect(webkitBody).toMatch(/height:\s*var\(--scrollbar-size\);/);
  });

  it("pins xterm's DOM scrollbar rail and thumb to the shared token", () => {
    const railBody = cssRuleBody(
      chromeCss,
      ".ae-terminal-panel .xterm .xterm-scrollable-element > .scrollbar.vertical",
    );
    expect(railBody).toMatch(/width:\s*var\(--scrollbar-size\)\s*!important;/);

    expect(chromeCss).toMatch(
      /\.xterm-scrollable-element\s*>\s*\.scrollbar\.vertical\s*>\s*\.slider\s*\{[\s\S]*?width:\s*var\(--scrollbar-size\)\s*!important;/,
    );
  });
});
