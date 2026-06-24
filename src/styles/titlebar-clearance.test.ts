import { describe, expect, it } from "vitest";

import { readAggregatedChromeCss } from "./css-test-utils";

const css = readAggregatedChromeCss();

describe("macOS overlay titlebar clearance", () => {
  it("left-aligns the sidebar wordmark after the macOS traffic lights", () => {
    expect(css).toMatch(
      /--ae-mac-titlebar-clearance:\s*calc\(94px \/ var\(--app-ui-scale,\s*1\)\);/,
    );
    expect(css).toMatch(
      /\[data-platform="mac"\]\s+\.a2ui-sidebar-title\s*\{[\s\S]*?padding-left:\s*var\(--ae-mac-titlebar-clearance\);/,
    );
    expect(css).toMatch(
      /\[data-platform="mac"\]\s+\.a2ui-sidebar-title\s+\.ae-wordmark\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*var\(--ae-mac-titlebar-clearance\);/,
    );
    expect(css).toMatch(
      /\[data-platform="mac"\]\s+\.a2ui-sidebar-title-version\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*var\(--space-3\);[\s\S]*?max-width:\s*max\(/,
    );
    expect(css).toMatch(
      /\[data-platform="mac"\]\[data-sidebar-collapsed="true"\]\s+\.app-header\s*\{[\s\S]*?padding-left:\s*var\(--ae-mac-titlebar-clearance\)\s*!important/,
    );
    expect(css).not.toMatch(/:has\(/);
  });
});
