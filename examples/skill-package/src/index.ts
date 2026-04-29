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
 *   - A single sidebar section "Demo Skill" with two items.
 *   - "Greet" click → `ctx.pi.notify`.
 *   - "Toast pulse-card" click → wraps the React component shipped by
 *     `frontendEntry` in a notification card so you can see it
 *     rendering. (`pulse-card` is registered on the frontend via the
 *     skill module loader; this skill's bridge-side code just emits an
 *     A2UI payload that references the type.)
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
    items: [
      { id: "skill-demo-greet", label: "Greet from npm skill" },
      { id: "skill-demo-pulse", label: "Show pulse-card" },
    ],
  });
  api.onEvent(
    { componentType: "sidebar", eventType: "select" },
    (event: SidebarSelectEvent, ctx) => {
      const data = event.data;
      if (data?.sectionId !== "skill-demo") return;
      if (data.itemId === "skill-demo-greet") {
        ctx.pi.notify("Hello from the demo npm skill 👋");
        return;
      }
      if (data.itemId === "skill-demo-pulse") {
        // The `pulse-card` type is registered on the frontend by this
        // skill's `aethon.frontendEntry`. Bridge-side code references
        // it like any built-in primitive; the renderer resolves it
        // through the SkillRegistry.
        api.setState("/canvas", {
          components: [
            {
              id: "skill-demo-pulse-instance",
              type: "pulse-card",
              props: { title: "Skill demo", state: "ok" },
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
