// @ts-expect-error frontend tsconfig intentionally does not include Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error frontend tsconfig intentionally does not include Node types.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chromeCss = readFileSync(
  fileURLToPath(new URL("../../styles/chrome.css", import.meta.url)),
  "utf8",
);

function cssRule(selector: string): string {
  const start = chromeCss.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = chromeCss.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return chromeCss.slice(start, end);
}

describe("message list zoom CSS contract", () => {
  it("keeps Virtuoso scroll math unzoomed while preserving row UI zoom", () => {
    expect(cssRule(".a2ui-canvas-scroller")).toContain(
      "zoom: calc(1 / var(--app-ui-scale, 1));",
    );
    expect(cssRule(".a2ui-chat-history")).toContain(
      "zoom: calc(1 / var(--app-ui-scale, 1));",
    );
    expect(cssRule(".a2ui-canvas-scroller .a2ui-msg-row")).toContain(
      "zoom: var(--app-ui-scale, 1);",
    );
    expect(cssRule(".a2ui-chat-history .a2ui-msg-row")).toContain(
      "zoom: var(--app-ui-scale, 1);",
    );
  });
});
