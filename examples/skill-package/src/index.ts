/**
 * Example Aethon skill distributed as an npm package.
 *
 * Install:
 *   npm install --prefix ~/.aethon/skills /path/to/this/dir
 *
 * Aethon walks `~/.aethon/skills/node_modules/` on startup and on every
 * extension hot-reload, looking for any package.json with an `aethon`
 * field. The `entry` is dynamically imported and its `register(api)`
 * export receives the same global Aethon API surface as a directory-
 * based extension under `~/.aethon/extensions/`.
 *
 * What this demo registers:
 *   - A single sidebar section "Demo Skill" with one item.
 *   - Click handler responds with `ctx.pi.notify`.
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
    id: "skill-demo",
    title: "Demo Skill",
    items: [{ id: "skill-demo-greet", label: "Greet from npm skill" }],
  });
  api.onEvent(
    { componentType: "sidebar", eventType: "select" },
    (event: SidebarSelectEvent, ctx) => {
      const data = event.data;
      if (data?.sectionId !== "skill-demo" || data.itemId !== "skill-demo-greet") return;
      ctx.pi.notify("Hello from the demo npm skill 👋");
    },
  );
}

export default { register };
