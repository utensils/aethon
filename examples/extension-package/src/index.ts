/**
 * Example Aethon extension distributed as an npm package.
 *
 * Install:
 *   npm install --prefix ~/.aethon/extensions /path/to/this/dir
 *
 * Aethon walks `~/.aethon/extensions/node_modules/` on startup and on every
 * extension hot-reload, looking for any package.json with an `aethon`
 * field. The `entry` is dynamically imported and its `register(api)`
 * export receives the same global Aethon API surface as a directory-
 * based extension under `~/.aethon/extensions/`.
 *
 * What this demo registers:
 *   - A single sidebar section "Demo Extension" with two items.
 *   - "Greet" click → `ctx.pi.notify`.
 *   - "Toast pulse-card" click → wraps the React component shipped by
 *     `frontendEntry` in a notification card so you can see it
 *     rendering. (`pulse-card` is registered on the frontend via the
 *     extension frontend loader; this extension's bridge-side code just
 *     emits an A2UI payload that references the type.)
 */

/// <reference path="../../pi-extensions/aethon-types.d.ts" />

interface SidebarSelectEvent {
  componentId?: string;
  componentType?: string;
  eventType?: string;
  data?: { sectionId?: string; itemId?: string };
}

export function register(api: typeof globalThis.aethon): void {
  if (!api) return;
  api.registerSidebarSection({
    id: "extension-demo",
    title: "Demo Extension",
    items: [
      { id: "extension-demo-greet", label: "Greet from npm extension" },
      { id: "extension-demo-pulse", label: "Show pulse-card" },
    ],
  });
  api.onEvent(
    { componentType: "sidebar", eventType: "select" },
    (event: SidebarSelectEvent, ctx) => {
      const data = event.data;
      if (data?.sectionId !== "extension-demo") return;
      if (data.itemId === "extension-demo-greet") {
        ctx.pi.notify("Hello from the demo npm extension 👋");
        return;
      }
      if (data.itemId === "extension-demo-pulse") {
        // The `pulse-card` type is registered on the frontend by this
        // extension's `aethon.frontendEntry`. Bridge-side code references
        // it like any built-in primitive; the renderer resolves it
        // through the ExtensionRegistry.
        api.setState("/canvas", {
          components: [
            {
              id: "extension-demo-pulse-instance",
              type: "pulse-card",
              props: { title: "Extension demo", state: "ok" },
            },
          ],
        });
        ctx.pi.notify("pulse-card rendered to /canvas");
        return;
      }
    },
  );
}

export default { register };
