// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { fileURLToPath } from "node:url";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
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

describe("terminal overflow containment CSS", () => {
  it("clips xterm internals so reload-restored terminals cannot leak below the panel", () => {
    const agentMount = cssRuleBody(chromeCss, ".a2ui-terminal-mount");
    expect(agentMount).toMatch(/overflow:\s*hidden;/);

    const shellWrap = cssRuleBody(chromeCss, ".ae-shell-canvas-wrap");
    expect(shellWrap).toMatch(/overflow:\s*hidden;/);

    const shellTerm = cssRuleBody(chromeCss, ".ae-shell-canvas-term");
    expect(shellTerm).toMatch(/overflow:\s*hidden;/);

    expect(chromeCss).toMatch(
      /\.ae-terminal-panel\s+\.xterm,\s*\.ae-terminal-panel\s+\.xterm-screen\s*\{[\s\S]*?overflow:\s*hidden;/,
    );
  });
});

describe("chat overflow containment CSS", () => {
  it("prevents the chat scroller from owning horizontal overflow", () => {
    const canvasScroller = cssRuleBody(chromeCss, ".a2ui-canvas-scroller");
    expect(canvasScroller).toMatch(/min-width:\s*0;/);
    expect(canvasScroller).toMatch(/max-width:\s*100%;/);
    expect(canvasScroller).toMatch(/overflow-x:\s*hidden;/);

    const chatHistory = cssRuleBody(chromeCss, ".a2ui-chat-history");
    expect(chatHistory).toMatch(/min-width:\s*0;/);
    expect(chatHistory).toMatch(/max-width:\s*100%;/);
    expect(chatHistory).toMatch(/overflow-x:\s*hidden;/);

    const row = cssRuleBody(chromeCss, ".a2ui-msg-row");
    expect(row).toMatch(/min-width:\s*0;/);
    expect(row).toMatch(/max-width:\s*100%;/);
  });

  it("wraps prose while keeping code and tables constrained locally", () => {
    expect(chromeCss).toMatch(
      /\.a2ui-chat-text,\s*\.a2ui-canvas-text\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/,
    );

    const markdownTable = cssRuleBody(chromeCss, ".a2ui-markdown table");
    expect(markdownTable).toMatch(/display:\s*block;/);
    expect(markdownTable).toMatch(/max-width:\s*100%;/);
    expect(markdownTable).toMatch(/overflow-x:\s*auto;/);

    const markdownImage = cssRuleBody(chromeCss, ".a2ui-markdown img");
    expect(markdownImage).toMatch(/max-width:\s*100%;/);
    expect(markdownImage).toMatch(/height:\s*auto;/);

    const codeBlock = cssRuleBody(chromeCss, ".a2ui-code");
    expect(codeBlock).toMatch(/min-width:\s*0;/);
    expect(codeBlock).toMatch(/max-width:\s*100%;/);
    expect(codeBlock).toMatch(/overflow-x:\s*auto;/);
  });
});
