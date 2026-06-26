import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VITE_PORT ?? 1420);

export default defineConfig({
  testDir: "./e2e",
  // The harness mocks one Tauri webview per test while sharing a Vite
  // dev server. Keep tests in a spec serial so a Vite reload in one page
  // cannot interrupt another page mid-turn.
  fullyParallel: false,
  // A single shared Vite dev server means cross-file parallelism would let
  // one spec's reload interrupt another. Pin to one worker so every test —
  // across files — runs serially, matching the harness's single-webview model.
  workers: 1,
  // Default retries are 0, so a single transient flake (a late React remount,
  // a Vite HMR reload landing mid-assertion) fails the whole suite and can
  // block a release. Retry twice in CI to absorb transient blips; keep local
  // runs strict at 0 so genuinely flaky tests surface during development.
  retries: process.env.CI ? 2 : 0,
  // Fail CI loudly if a stray `test.only` is committed rather than silently
  // running a subset and reporting green.
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `VITE_PORT=${port} bun run dev -- --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
