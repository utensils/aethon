// vitest/config re-exports Vite's defineConfig with a `test` field on
// the schema; Vite's own defineConfig narrows it away.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// Tauri requires a fixed dev port (devUrl in tauri.conf.json). For
// auto-increment, the `dev` wrapper (scripts/dev.sh) finds a free port
// starting at 1420, exports VITE_PORT, and overrides devUrl via
// $TAURI_CONFIG so Tauri loads from the same port. strictPort stays
// true: if the wrapper handed us a busy port we want to fail loudly,
// not silently jump to a port the Tauri shell isn't watching.
const port = Number(process.env.VITE_PORT ?? 1420);

export default defineConfig({
  plugins: [
    react(),
    // Bundle-composition report for perf work: `ANALYZE=1 bun run build`
    // writes dist/stats.html. Never active in normal builds.
    ...(process.env.ANALYZE
      ? [visualizer({ filename: "dist/stats.html", gzipSize: true })]
      : []),
  ],
  clearScreen: false,
  optimizeDeps: {
    // The dep scanner treats every root-level .html as an entry, which
    // pulls in index.mobile.html → the @tauri-real/* aliases that only
    // vite.mobile.config.ts defines. Scope the desktop scan to the
    // desktop entry.
    entries: ["index.html"],
  },
  server: {
    port,
    strictPort: true,
    watch: {
      // Nix's `.direnv` directory contains thousands of read-only
      // store-path mirrors of flake inputs — including stray
      // `tsconfig.json` / `index.html` files that aren't part of our
      // source tree. When Vite's tsconfig probe walks into one of
      // them it triggers a "changed tsconfig file detected — full
      // reload" cascade that nukes the webview's Tauri IPC mid-call
      // ("IPC custom protocol failed, Tauri will now use the
      // postMessage interface instead"). Excluding the whole
      // `.direnv` tree keeps the dev loop hermetic.
      ignored: [
        "**/.direnv/**",
        "**/target/**",
        "**/src-tauri/target/**",
        "**/node_modules/**",
        "**/playwright-report/**",
        "**/test-results/**",
      ],
    },
  },
  build: {
    target: "es2022",
  },
  test: {
    // Pure-logic unit tests live next to the source as `*.test.ts` and
    // run under node for speed. React/hook tests opt into jsdom on a
    // per-file basis with `// @vitest-environment jsdom` at the top —
    // vitest 4 dropped environmentMatchGlobs in favor of the directive.
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "agent/**/*.test.ts",
      "cli/**/*.test.ts",
    ],
    setupFiles: ["src/test/setup.ts"],
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
