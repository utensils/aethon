// Entry point for the iOS companion build (index.mobile.html). Mirrors
// main.tsx's boot-theme + style order, but mounts MobileGate — which
// gates on the gateway handshake before mounting the reused App — rather
// than App directly. Deliberately does not import mainApp.tsx: that
// eagerly pulls Monaco + Shiki prewarm, which the phone doesn't need at
// boot.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { applyBootTheme } from "../themeBootstrap";
import { MobileGate } from "./MobileGate";
import "../styles/tokens.css";
import "../styles/themes.css";
import "../styles/chrome.css";
import "../styles/mobile.css";

applyBootTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileGate />
  </StrictMode>,
);
