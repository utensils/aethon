// vitest/config re-exports Vite's defineConfig with a `test` field on
// the schema; Vite's own defineConfig narrows it away.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
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
