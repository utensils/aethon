import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.tsx";
import { prewarmHighlighter } from "./utils/highlight";
// Side-effect import: registers Monaco's web-worker factories and binds
// the @monaco-editor/react loader to the bundled monaco package so the
// editor mounts work offline / under Tauri's CSP. Must run before any
// component imports a Monaco-backed surface.
import "./monaco/setup";
import "./styles/index.css";

// Expose Tauri's invoke globally in dev so the aethon-debug skill's TCP eval
// server can wrap user JS to call back via __AETHON_INVOKE__('debug_eval_result', ...).
// Compiled out of release builds.
if (import.meta.env.DEV) {
  (window as unknown as { __AETHON_INVOKE__: typeof invoke }).__AETHON_INVOKE__ = invoke;
}

// Spawn the Shiki highlight worker eagerly so the first user-visible code
// block doesn't pay the cold-start cost (Oniguruma WASM + theme parse).
// Idempotent; safe to call here.
prewarmHighlighter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
