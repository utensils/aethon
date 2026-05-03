// vitest/config re-exports Vite's defineConfig with a `test` field on
// the schema; Vite's own defineConfig narrows it away.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// Tauri requires a fixed dev port (devUrl in tauri.conf.json). For
// auto-increment, the `dev` wrapper (scripts/dev.sh) finds a free port
// starting at 1420, exports VITE_PORT, and overrides devUrl via
// $TAURI_CONFIG so Tauri loads from the same port. strictPort stays
// true: if the wrapper handed us a busy port we want to fail loudly,
// not silently jump to a port the Tauri shell isn't watching.
const port = Number(process.env.VITE_PORT ?? 1420);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Single source of truth for the displayed app version. Read from
  // package.json at build time and exposed to the frontend as
  // `__APP_VERSION__`. The UI's sidebar/header binds this via the
  // `/appVersion` state path so the layout JSON doesn't have to
  // hardcode anything. Cargo.toml + tauri.conf.json must stay in lock-
  // step manually (the release script handles this).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
  test: {
    // Pure-logic unit tests live next to the source as `*.test.ts`.
    // jsdom is reserved for the renderer when we add component tests;
    // current suite is utility code only so node is faster.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "agent/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/main.tsx",
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
      ],
    },
  },
});
