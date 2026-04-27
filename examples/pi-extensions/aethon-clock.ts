/**
 * Pi extension example — registers an Aethon `clock-card` component when
 * loaded inside Aethon. When loaded by pi's TUI directly, the `aethon`
 * global is absent and the extension no-ops gracefully.
 *
 * Install: copy or symlink this file into `~/.pi/agent/extensions/`. Pi
 * loads it automatically; Aethon's bridge attaches the `aethon` global
 * before pi's loader runs.
 */

/// <reference path="./aethon-types.d.ts" />

interface PiExtensionApi {
  // Pi's full ExtensionAPI is broader; only the bits this demo uses are
  // typed here. See pi-coding-agent's ExtensionAPI for the full surface.
  registerCommand?(name: string, options: unknown): void;
}

// Pi expects a default export — the function is called with the pi
// ExtensionAPI when the extension is loaded.
export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) {
    // Loaded outside Aethon (pi TUI). Nothing to do.
    return;
  }

  globalThis.aethon.registerComponent("clock-card", {
    id: "clock-card-tpl",
    type: "card",
    props: {
      title: "Local time",
      description: { $ref: "/clock/now" },
    },
    children: [
      {
        id: "clock-card-uptime",
        type: "text",
        props: {
          content: { $ref: "/clock/uptimeLabel" },
          variant: "small",
          color: "var(--text-dim)",
        },
      },
    ],
  });

  const startedAt = Date.now();
  const tick = () => {
    globalThis.aethon!.setState("/clock/now", new Date().toLocaleTimeString());
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    globalThis.aethon!.setState(
      "/clock/uptimeLabel",
      `agent uptime ${h}h ${m}m ${s}s`,
    );
  };
  tick();
  setInterval(tick, 1000);
}
