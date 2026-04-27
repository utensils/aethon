/**
 * Pi extension example — adds a "Demo Tools" section to Aethon's sidebar.
 *
 * Demonstrates registerSidebarSection for adding extension surfaces to
 * the workspace chrome (not just per-message cards). Item clicks fire
 * `select` events on the sidebar; the extension routes those to actions.
 *
 * Install: copy or symlink into `~/.pi/agent/extensions/`.
 */

/// <reference path="./aethon-types.d.ts" />

interface PiExtensionApi {
  registerCommand?(name: string, options: unknown): void;
}

export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) return;
  const aethon = globalThis.aethon;

  aethon.registerSidebarSection({
    id: "demo-tools",
    title: "Demo Tools",
    items: [
      { id: "demo-greet", label: "Say hello" },
      { id: "demo-now", label: "Show time" },
    ],
  });

  // Pre-seed the canvas slot path the items target so the first click
  // doesn't 404. Empty subtree until something fires.
  aethon.setState("/canvas", null);

  aethon.onEvent(
    { componentType: "sidebar", eventType: "select" },
    (event, ctx) => {
      const data = event.data as { sectionId?: string; itemId?: string } | undefined;
      if (data?.sectionId !== "demo-tools") return;
      if (data.itemId === "demo-greet") {
        ctx.setState("/canvas", {
          components: [
            {
              id: "demo-greet-card",
              type: "card",
              props: {
                title: "Hello from a pi extension",
                description: "Click came in via aethon.onEvent on the sidebar",
              },
            },
          ],
        });
      }
      if (data.itemId === "demo-now") {
        ctx.setState("/canvas", {
          components: [
            {
              id: "demo-now-card",
              type: "card",
              props: {
                title: "Current time",
                description: new Date().toLocaleString(),
              },
            },
          ],
        });
      }
    },
  );
}
