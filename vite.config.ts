import { defineConfig } from "vite";
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
});
