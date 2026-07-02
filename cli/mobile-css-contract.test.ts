import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/mobile.css", import.meta.url), {
  encoding: "utf8",
});

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

describe("mobile CSS layout contract", () => {
  it("prevents horizontal scrolling in project list and detail panes", () => {
    expect(ruleBody(".ae-mobile-projects")).toContain("overflow-x: hidden");
    expect(ruleBody(".ae-mobile-project-detail")).toContain(
      "overflow-x: hidden",
    );
  });

  it("stacks dense workspace and detail rows on narrow phones", () => {
    const narrowRules = css.match(
      /@media\s*\(max-width:\s*380px\)\s*\{([\s\S]*?)\/\* Sessions screen \*\//m,
    )?.[1];

    expect(narrowRules).toContain(".ae-mobile-workspace");
    expect(narrowRules).toContain(".ae-mobile-detail-row");
    expect(narrowRules).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(narrowRules).toContain("max-width: none");
  });
});
