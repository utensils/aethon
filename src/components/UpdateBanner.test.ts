// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { dirname, join } from "node:path";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UpdaterStateView } from "../hooks/useUpdater";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "UpdateBanner.module.css"), "utf8");
const themeCss = readFileSync(join(here, "../styles/themes.css"), "utf8");
const updateBannerPrimaryForeground =
  "var(--accent-fg, var(--text-on-accent, var(--btn-text, #fff)))";
const builtInThemes: string[] = [];
for (const match of themeCss.matchAll(/:root\[data-theme="([^"]+)"\]/g)) {
  builtInThemes.push(match[1]);
}

function updateBannerPrimaryRule(): string {
  const primaryRules: string[] = [];
  for (const match of css.matchAll(/\.btnPrimary\s*\{([^}]*)\}/g)) {
    primaryRules.push(match[1]);
  }
  const rule = primaryRules.find((block) =>
    /background:\s*var\(--accent/.test(block),
  );
  if (!rule) throw new Error("Missing solid .btnPrimary rule");
  return rule;
}

function declarationValue(rule: string, property: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`).exec(rule);
  if (!match) throw new Error(`Missing ${property} declaration`);
  return match[1].trim();
}

function normalizeCssValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}

function themeVars(themeId: string): Record<string, string> {
  const blockMatch = new RegExp(
    `(?:^|\\n)[^{}]*\\[data-theme="${themeId}"\\][^{}]*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(themeCss);
  if (!blockMatch) throw new Error(`Missing ${themeId} theme block`);

  const vars: Record<string, string> = {};
  for (const match of blockMatch[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

function updateBannerPrimaryForegroundFor(
  vars: Record<string, string>,
): string {
  return (
    vars["--accent-fg"] ??
    vars["--text-on-accent"] ??
    vars["--btn-text"] ??
    "#fff"
  );
}

function parseHexColor(hex: string): [number, number, number] {
  const match = /^#([\da-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Expected 6-digit hex color, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHexColor(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function updateBannerPrimaryContrast(themeId: string): number {
  const vars = themeVars(themeId);
  return contrastRatio(updateBannerPrimaryForegroundFor(vars), vars["--accent"]);
}

const baseState: UpdaterStateView = {
  available: true,
  version: "0.4.0-dev.66.g4e64993",
  body: null,
  channel: "nightly",
  disableAutoCheck: false,
  downloading: false,
  preparing: null,
  progress: 0,
  error: null,
  dismissed: false,
};

describe("UpdateBanner stylesheet", () => {
  it("reserves macOS overlay titlebar space for the traffic lights", () => {
    expect(css).toMatch(/\[data-platform="mac"\]\s+\.banner\s*\{/);
    expect(css).toMatch(/padding-left:\s*max\(94px,\s*0\.9rem\)/);
  });

  it("uses theme accent foreground fallbacks for the primary action", () => {
    expect(
      normalizeCssValue(declarationValue(updateBannerPrimaryRule(), "color")),
    ).toBe(normalizeCssValue(updateBannerPrimaryForeground));
  });

  it("resolves the Brink primary action foreground to WCAG AA contrast", () => {
    const brinkVars = themeVars("brink");

    expect(updateBannerPrimaryForegroundFor(brinkVars)).toBe("#272020");
    expect(updateBannerPrimaryContrast("brink")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps built-in theme primary action fallback contrast WCAG AA compliant", () => {
    expect(builtInThemes).toContain("brink");

    const failingThemes = builtInThemes.filter(
      (themeId) => updateBannerPrimaryContrast(themeId) < 4.5,
    );

    expect(failingThemes).toEqual([]);
  });
});

describe("UpdateBanner", () => {
  const render = (state: UpdaterStateView) =>
    renderToStaticMarkup(
      createElement(UpdateBanner, {
        state,
        onInstallNow: vi.fn(),
        onDismiss: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

  it("renders the available nightly update controls", () => {
    const html = render(baseState);

    expect(html).toContain("Aethon Nightly");
    expect(html).toContain("v0.4.0-dev.66.g4e64993");
    expect(html).toContain("Install Now");
    expect(html).toContain("Dismiss");
  });

  it("renders the download progress view without install controls", () => {
    const html = render({
      ...baseState,
      downloading: true,
      preparing: "downloading",
      progress: 42,
    });

    expect(html).toContain("Downloading update");
    expect(html).toContain("42%");
    expect(html).toContain("width:42%");
    expect(html).not.toContain("Install Now");
  });
});
