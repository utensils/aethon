import { describe, expect, it } from "vitest";

import { readAggregatedChromeCss } from "../../styles/css-test-utils";

const chromeCss = readAggregatedChromeCss();

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
