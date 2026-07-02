import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.tsx";
import NativeCanvasWindowApp from "./NativeCanvasWindowApp";
import { prewarmHighlighter } from "./utils/highlight";
// Side-effect import: registers Monaco's web-worker factories and binds
// the @monaco-editor/react loader to the bundled monaco package so the
// editor mounts work offline / under Tauri's CSP. Must run before any
// component imports a Monaco-backed surface.
import "./monaco/setup";
// Style entry. Order matters: shape tokens first (theme-agnostic), then
// theme color tokens, then chrome rules (consumes everything). Import
// each file directly here instead of chaining through `@import` in a
// single index.css — Vite's HMR dep graph tracks JS module imports
// reliably, but `@import` chains in CSS files have produced silently
// stale stylesheets in the webview after edits to chrome.css.
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

// Spawn the Shiki highlight worker eagerly so the first user-visible code
// block doesn't pay the cold-start cost (Oniguruma WASM + theme parse).
// Idempotent; safe to call here.
prewarmHighlighter();

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface");
const canvasWindowId = params.get("id") ?? "";

bootMark("render-start");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {surface === "canvas-window" ? (
      <NativeCanvasWindowApp id={canvasWindowId} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
