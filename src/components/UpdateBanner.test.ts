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
