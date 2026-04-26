/**
 * Aethon extension example — registers a custom A2UI `clock-card` component
 * type and pushes the current time into state every second.
 *
 * Install: copy or symlink this file into `~/.aethon/extensions/`, then
 * restart the agent (touch agent/main.ts in dev). The card appears wherever
 * the agent emits `{type: "clock-card"}` in an A2UI payload.
 *
 * The Aethon API exposed via the `register(api)` argument:
 *   - registerComponent(componentType, template) — declarative A2UI subtree
 *   - setState(path, value) — JSON Pointer mutation against the layout state
 */

interface AethonApi {
  registerComponent(componentType: string, template: unknown): void;
  setState(path: string, value: unknown): void;
}

export function register(api: AethonApi): void {
  api.registerComponent("clock-card", {
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
    api.setState("/clock/now", new Date().toLocaleTimeString());
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    api.setState(
      "/clock/uptimeLabel",
      `agent uptime ${h}h ${m}m ${s}s`,
    );
  };
  tick();
  setInterval(tick, 1000);
}
