// Build config for the iOS companion surface. Reuses the entire React
// app in `src/`, but aliases Tauri's in-process IPC to the gateway
// shims so every `invoke`/`listen` rides the WebSocket transport to a
// paired desktop instead of a local Tauri runtime.
//
// The desktop build (vite.config.ts) is untouched — it keeps the real
// @tauri-apps/api. Only this config swaps them, and the alias also
// rewrites the same imports inside node_modules plugins (which a source
// codemod could never reach).

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const shim = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The Tauri mobile dev-server host, injected by `tauri ios dev` so a
// physical device can reach the Vite server; unset for the simulator /
// browser loop (localhost).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "aethon-mobile-index",
      // The entry file is index.mobile.html (the repo root's index.html
      // is the desktop entry), but Tauri's embedded-asset resolver and
      // the webview both load index.html at the root — without these
      // two hooks the packaged app boots to a black screen and the dev
      // server serves the desktop entry.
      writeBundle(options) {
        const dir = options.dir ?? shim("./dist-mobile");
        const from = join(dir, "index.mobile.html");
        if (existsSync(from)) renameSync(from, join(dir, "index.html"));
      },
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url?.startsWith("/?")) {
            req.url = `/index.mobile.html${req.url.slice(1)}`;
          }
          next();
        });
      },
    },
  ],
  clearScreen: false,
  resolve: {
    // Exact-match regex so the shims' own `@tauri-apps/api/core.js` /
    // `event.js` re-export imports resolve to the real modules and only
    // the extension-less specifier is intercepted.
    alias: [
      {
        find: /^@tauri-apps\/api\/core$/,
        replacement: shim("./src/gateway/tauriCoreShim.ts"),
      },
      {
        find: /^@tauri-apps\/api\/event$/,
        replacement: shim("./src/gateway/tauriEventShim.ts"),
      },
      // The shims re-export the genuine modules under these specifiers
      // (matching the tsconfig `paths`), so `export *` reaches the real
      // implementation instead of aliasing back onto itself.
      {
        find: "@tauri-real/core",
        replacement: shim("./node_modules/@tauri-apps/api/core.js"),
      },
      {
        find: "@tauri-real/event",
        replacement: shim("./node_modules/@tauri-apps/api/event.js"),
      },
    ],
  },
  define: {
    "import.meta.env.VITE_AETHON_SURFACE": JSON.stringify("mobile"),
  },
  build: {
    target: "es2022",
    outDir: "dist-mobile",
    rollupOptions: {
      input: shim("./index.mobile.html"),
    },
  },
  server: {
    host: host || false,
    port: 1430,
    strictPort: true,
    // Tauri's mobile dev loop proxies this server through the
    // tauri://localhost custom scheme, which WKWebView treats as an
    // opaque origin — module-script loads then run in CORS mode and
    // need this header or they all fail (white screen).
    headers: { "access-control-allow-origin": "*" },
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: {
      ignored: ["**/.direnv/**", "**/target/**", "**/node_modules/**"],
    },
  },
});
