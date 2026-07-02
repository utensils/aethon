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
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const shim = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The Tauri mobile dev-server host, injected by `tauri ios dev` so a
// physical device can reach the Vite server; unset for the simulator /
// browser loop (localhost).
const host = process.env.TAURI_DEV_HOST;

// D6: desktop-only modules redirected to lightweight stubs for the
// mobile build (dev server + `build:mobile`) only — see the resolveId
// hook below for why. Keyed by the RESOLVED absolute source path so the
// redirect fires no matter which relative specifier (`"./canvas"`,
// `"../monaco/theme"`, `"../../../monaco/editor-buffers"`, …) a given
// importer happens to use.
const DESKTOP_ONLY_REDIRECTS: Array<{ target: string; stub: string }> = [
  {
    target: shim("./src/extensions/default-layout/editor/canvas.tsx"),
    stub: shim("./src/mobile/composites/desktop-only-canvas.tsx"),
  },
  {
    target: shim("./src/extensions/default-layout/editor/diff-canvas.tsx"),
    stub: shim("./src/mobile/composites/desktop-only-canvas.tsx"),
  },
  {
    target: shim("./src/monaco/theme.ts"),
    stub: shim("./src/mobile/monacoThemeStub.ts"),
  },
  {
    target: shim("./src/monaco/editor-buffers.ts"),
    stub: shim("./src/mobile/editorBufferStub.ts"),
  },
];

// Resolve a relative specifier against its importer's directory, trying
// the extensions Vite would try, so it can be compared against the
// absolute `target` paths above regardless of which extension-less form
// the importer used.
function resolveRelative(source: string, importer: string): string | null {
  if (!source.startsWith(".")) return null;
  const base = resolvePath(dirname(importer), source);
  for (const ext of ["", ".tsx", ".ts"]) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

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
        server.middlewares.use((req, res, next) => {
          // Dev-only perf beacon: src/mobile/perfMarks.ts POSTs its
          // startup report here so on-device numbers land in this
          // terminal without Safari's inspector attached.
          if (req.url === "/__perf" && req.method === "POST") {
            // Bound the body: this server can be LAN-reachable via
            // TAURI_DEV_HOST, and perf reports are ~1 KB.
            const MAX_PERF_BODY = 64 * 1024;
            let body = "";
            let receivedBytes = 0;
            let overflow = false;
            req.on("data", (chunk: Buffer) => {
              if (overflow) return;
              // Count raw bytes BEFORE decoding so an oversized chunk
              // is rejected without the allocation, and the limit is
              // bytes rather than UTF-16 code units.
              receivedBytes += chunk.length;
              if (receivedBytes > MAX_PERF_BODY) {
                overflow = true;
                body = "";
                res.statusCode = 413;
                res.end();
                req.destroy();
                return;
              }
              body += chunk.toString();
            });
            req.on("end", () => {
              if (overflow) return;
              console.log("[aethon:mobile-perf]", body);
              res.statusCode = 204;
              res.end();
            });
            return;
          }
          if (req.url === "/" || req.url?.startsWith("/?")) {
            req.url = `/index.mobile.html${req.url.slice(1)}`;
          }
          next();
        });
      },
    },
    // D6: the mobile layout (mobile.a2ui.json) never places editor-canvas
    // or diff-canvas, but src/extensions/default-layout/components.tsx
    // statically imports both (they're assigned into the registry object,
    // so plain tree-shaking can't drop them even though nothing on mobile
    // ever renders that A2UI type). Their real implementations reach all
    // of monaco-editor plus its default language contributions — whose
    // ts/css/html/json/editor worker chunks (~7 MB+ unminified) Vite
    // auto-splits into separate async chunks that still ship dead in the
    // IPA. Two other modules reach the same monaco-editor import from
    // paths that have nothing to do with the canvas: `windowApi.ts`
    // (universal `window.aethon` wiring) imports `monaco/theme.ts`,
    // which unconditionally imports `monaco/setup.ts`'s five explicit
    // `?worker` imports; and the generic tab-lifecycle hooks
    // (useProjectOps, closeTab, tabCleanup, orphanTabSweep,
    // useEditorExternalChange) import `monaco/editor-buffers.ts`, whose
    // bare `import * as monaco from "monaco-editor"` alone is enough to
    // pull in monaco's default language contributions. All four targets
    // are safe to redirect on mobile: editor-canvas/diff-canvas never
    // mount there, so nothing ever actually creates a Monaco model or
    // theme to apply.
    //
    // A declarative `resolve.alias` entry can't express this redirect:
    // Vite's alias plugin matches the literal specifier text as written
    // in the importing file (e.g. "./canvas"), not the resolved absolute
    // path — and "./canvas" is also the specifier `shell/index.ts` uses
    // for the unrelated `ShellCanvas`, so a text-based alias would either
    // never fire (matching against an absolute-path regex) or wrongly
    // redirect the shell canvas too (matching bare "./canvas"). Instead
    // this resolveId hook manually resolves each relative specifier
    // against its importer and compares the RESULT against the resolved
    // absolute target paths in DESKTOP_ONLY_REDIRECTS — precise
    // regardless of how many `../` a given importer needs, and immune to
    // specifier-text collisions with unrelated same-named files.
    {
      name: "aethon-mobile-desktop-only",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return null;
        const resolved = resolveRelative(source, importer);
        if (!resolved) return null;
        const hit = DESKTOP_ONLY_REDIRECTS.find((r) => r.target === resolved);
        return hit ? hit.stub : null;
      },
    },
    // `ANALYZE=1 bun run build:mobile` writes dist-mobile/stats.html.
    ...(process.env.ANALYZE
      ? [visualizer({ filename: "dist-mobile/stats.html", gzipSize: true })]
      : []),
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
