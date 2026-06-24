import { describe, expect, it } from "vitest";

import { readAggregatedChromeCss } from "./css-test-utils";

const chromeCss = readAggregatedChromeCss();

function cssRuleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = chromeCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `${selector} rule should exist`).not.toBeNull();
  return match?.[1] ?? "";
}

function cssProperty(body: string, name: string): string {
  const match = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(match, `${name} property should exist`).not.toBeNull();
  return match?.[1]?.trim() ?? "";
}

describe("VCS merged PR badge CSS", () => {
  it("matches the source-control merged badge to the workspace success treatment", () => {
    const workspaceMerged = cssRuleBody(".ae-pr-merged");
    const sourceControlMerged = cssRuleBody(".ae-scm-badge.is-merged");

    expect(cssProperty(sourceControlMerged, "background")).toBe(
      cssProperty(workspaceMerged, "background"),
    );
    expect(cssProperty(sourceControlMerged, "color")).toBe(
      cssProperty(workspaceMerged, "color"),
    );
  });

  it("keeps merged PR badges separate from neutral styling", () => {
    const sourceControlMerged = cssRuleBody(".ae-scm-badge.is-merged");
    const sourceControlNeutral = cssRuleBody(".ae-scm-badge.is-neutral");

    expect(sourceControlMerged).toContain("var(--state-success-bg)");
    expect(sourceControlMerged).toContain("var(--state-success-fg)");
    expect(sourceControlNeutral).not.toContain("var(--state-success-bg)");
    expect(sourceControlNeutral).not.toContain("var(--state-success-fg)");
  });

  it("gives header PR chips the same explicit merged tone", () => {
    const headerMerged = cssRuleBody(".ae-vcs-chip.is-merged");

    expect(cssProperty(headerMerged, "background")).toBe(
      cssProperty(cssRuleBody(".ae-pr-merged"), "background"),
    );
    expect(cssProperty(headerMerged, "color")).toBe(
      cssProperty(cssRuleBody(".ae-pr-merged"), "color"),
    );
  });
});
