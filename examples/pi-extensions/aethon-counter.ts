/**
 * Pi extension example — interactive counter card. Demonstrates Aethon's
 * a2ui_event handler routing: a button inside an extension-registered
 * template triggers a handler that updates state, which the same template
 * re-reads via `$ref`. Zero LLM round-trip.
 *
 * Install: copy or symlink into `~/.pi/agent/extensions/`. Then ask the
 * agent to emit `{type: "counter-card"}` (or inject via debug-eval).
 */

/// <reference path="./aethon-types.d.ts" />

interface PiExtensionApi {
  registerCommand?(name: string, options: unknown): void;
}

export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) return;
  const aethon = globalThis.aethon;

  aethon.setState("/counter/value", 0);

  aethon.registerComponent("counter-card", {
    type: "card",
    props: {
      title: "Interactive counter",
      description: { $ref: "/counter/value" },
    },
    children: [
      {
        id: "btn-inc",
        type: "button",
        props: { label: "+1", variant: "primary", onClick: "click" },
      },
      {
        id: "btn-reset",
        type: "button",
        props: { label: "Reset", variant: "ghost", onClick: "click" },
      },
    ],
  });

  // Match buttons inside a counter-card by descendant id. The bridge
  // splits the prefixed componentId on `__tpl__` so descendantId is the
  // raw template-side id (here: "btn-inc" or "btn-reset").
  aethon.onEvent(
    { templateRootType: "counter-card", descendantId: "btn-inc", eventType: "click" },
    (_event, ctx) => {
      // We need the current value to increment. Read isn't part of the
      // first-cut API surface — track it ourselves so we don't have to
      // round-trip through the frontend.
      currentValue += 1;
      ctx.setState("/counter/value", currentValue);
    },
  );

  aethon.onEvent(
    { templateRootType: "counter-card", descendantId: "btn-reset", eventType: "click" },
    (_event, ctx) => {
      currentValue = 0;
      ctx.setState("/counter/value", currentValue);
    },
  );

  let currentValue = 0;
}
