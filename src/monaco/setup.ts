/**
 * Monaco editor bootstrap.
 *
 * Runs once before the first `<Editor>` mounts. Two responsibilities:
 *
 * 1. **Worker plumbing.** Monaco runs its language services on web workers.
 *    Vite's `?worker` import syntax compiles each into its own bundle so
 *    they're loaded on demand. The `MonacoEnvironment.getWorker` shim wires
 *    label → worker factory. Without this, Monaco falls back to running
 *    services on the main thread and typing latency in large files dies.
 *
 * 2. **Loader binding.** `@monaco-editor/react` defaults to loading Monaco
 *    from `cdn.jsdelivr.net`. Tauri ships offline; the bundled CSP also
 *    forbids cross-origin script loads. `loader.config({ monaco })` pins
 *    the React wrapper to the locally-bundled `monaco-editor` package so
 *    everything stays self-hosted.
 *
 * Side-effect-only module. Import once from `main.tsx` before render —
 * `loader.init()` resolves immediately if the loader has already been
 * configured, so first-mount latency is just the workers spinning up.
 *
 * Pattern cribbed from Claudette's `monacoSetup.ts`; if either project
 * diverges from this shape, the other usually wants the same change.
 */

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

if (typeof window !== "undefined" && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

loader.config({ monaco });

// Install the WebKit-only context-view positioning fix once, here, so
// Monaco's right-click menu lands at the cursor under non-1 UI zoom.
// On Chromium/at-zoom-1 every callback short-circuits — no measurable
// runtime cost.
import { installMonacoContextViewFix } from "./context-view-fix";
installMonacoContextViewFix();

export { monaco };
