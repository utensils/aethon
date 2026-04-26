import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.tsx";
import "./styles.css";

// Expose Tauri's invoke globally in dev so the aethon-debug skill's TCP eval
// server can wrap user JS to call back via __AETHON_INVOKE__('debug_eval_result', ...).
// Compiled out of release builds.
if (import.meta.env.DEV) {
  (window as unknown as { __AETHON_INVOKE__: typeof invoke }).__AETHON_INVOKE__ = invoke;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
