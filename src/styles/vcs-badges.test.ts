// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { fileURLToPath } from "node:url";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const chromeCss = readFileSync(join(here, "chrome.css"), "utf8");

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
  it("matches the source-control merged badge to the worktree purple treatment", () => {
    const worktreeMerged = cssRuleBody(".ae-pr-merged");
    const sourceControlMerged = cssRuleBody(".ae-scm-badge.is-merged");

    expect(cssProperty(sourceControlMerged, "background")).toBe(
      cssProperty(worktreeMerged, "background"),
    );
    expect(cssProperty(sourceControlMerged, "color")).toBe(
      cssProperty(worktreeMerged, "color"),
    );
  });

  it("keeps merged PR badges separate from neutral styling", () => {
    const sourceControlMerged = cssRuleBody(".ae-scm-badge.is-merged");
    const sourceControlNeutral = cssRuleBody(".ae-scm-badge.is-neutral");

    expect(sourceControlMerged).toContain("#b58aff");
    expect(sourceControlNeutral).not.toContain("#b58aff");
    expect(sourceControlNeutral).not.toMatch(/background:\s*rgba\(140, 82, 255, 0\.15\);/);
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
