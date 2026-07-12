import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { prewarmHighlighter } from "./utils/highlight";
// NOTE: monaco's bootstrap (worker factories + loader binding) moved to
// the top of editor/canvas.tsx + diff-canvas.tsx — the chunks that
// actually create models — so the multi-MB monaco graph stays out of
// the boot bundle.
// Style entry. Order matters: shape tokens first (theme-agnostic), then
// theme color tokens, then chrome rules (consumes everything). Import
// each file directly here instead of chaining through `@import` in a
// single index.css — Vite's HMR dep graph tracks JS module imports
// reliably, but `@import` chains in CSS files have produced silently
// stale stylesheets in the webview after edits to chrome.css.
import "./styles/fonts";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/chrome.css";
import { bootMark } from "./utils/bootTrace";

// Everything above this line — including the monaco/setup side effects —
// has evaluated by the time this mark lands.
bootMark("mainapp-eval");

// Expose Tauri's invoke globally in dev so the aethon-debug skill's TCP eval
// server can wrap user JS to call back via __AETHON_INVOKE__('debug_eval_result', ...).
// Compiled out of release builds.
if (import.meta.env.DEV) {
  (
    window as unknown as { __AETHON_INVOKE__: typeof invoke }
  ).__AETHON_INVOKE__ = invoke;
}

// Spawn the Shiki highlight worker once the main thread goes idle — warm
// before the first realistic user message without competing with first
// paint for CPU (the worker boot parses Oniguruma WASM + themes).
// Idempotent; HighlightedCode renders plain text until it resolves.
// WebKit has no requestIdleCallback — feature-detect and fall back.
const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 3_000 })
    : (cb) => setTimeout(cb, 1_500);
scheduleIdle(() => prewarmHighlighter());

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface");
const canvasWindowId = params.get("id") ?? "";

// Route before importing either application graph. Native canvas windows do
// not need the full workstation orchestration, and the main window does not
// need native-canvas state or listeners. Keeping these as separate chunks
// reduces parse/evaluation work for both surfaces.
async function renderSurface(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  if (surface === "canvas-window") {
    const { default: NativeCanvasWindowApp } = await import(
      "./NativeCanvasWindowApp"
    );
    bootMark("render-start");
    root.render(
      <StrictMode>
        <NativeCanvasWindowApp id={canvasWindowId} />
      </StrictMode>,
    );
    return;
  }

  const { default: App } = await import("./App.tsx");
  bootMark("render-start");
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void renderSurface();
