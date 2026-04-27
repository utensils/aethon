/**
 * Ambient type declarations so a pi extension running inside Aethon can
 * reach the Aethon UI surface via `globalThis.aethon`. Copy this file
 * (or `///<reference />` it) alongside any pi extension that wants to
 * register Aethon UI.
 *
 * The global is only present when the extension runs inside Aethon. When
 * the same extension is loaded by pi's TUI directly, `globalThis.aethon`
 * is `undefined` — guard with `if (globalThis.aethon)` or `?.`.
 */

interface AethonEventInfo {
  componentId?: string;
  /** Type of the rendered component the event came from (e.g. "button"). */
  componentType?: string;
  /** Type of the host template if the event fired inside an expanded template. */
  templateRootType?: string;
  eventType?: string;
  data?: unknown;
}

interface AethonEventMatch {
  /** Match events from inside a template expansion of this type. */
  templateRootType?: string;
  /** Match the rendered component's own type. */
  componentType?: string;
  /** Match the descendant id (the part of componentId after `__tpl__`). */
  descendantId?: string;
  /** Match the event name (e.g. "click", "submit", "change"). */
  eventType?: string;
}

interface AethonEventCtx {
  setState(path: string, value: unknown): void;
  registerComponent(componentType: string, template: unknown): void;
}

declare global {
  // eslint-disable-next-line no-var
  var aethon:
    | {
        /**
         * Register an A2UI subtree under a custom component type. When any
         * agent-emitted A2UI payload references `{type: "<componentType>"}`
         * the renderer expands the template inline. Templates may bind
         * data with JSON Pointer `$ref`s against shared state.
         */
        registerComponent(componentType: string, template: unknown): void;

        /**
         * Mutate the frontend layout state at the given JSON Pointer path.
         * Used by extensions to push live data (clocks, notifications)
         * into bound templates. Retained by the bridge so a webview
         * reload restores the latest values.
         */
        setState(path: string, value: unknown): void;

        /**
         * Register a handler for events dispatched from A2UI components.
         * `match` filters by templateRootType / componentType / descendantId
         * / eventType — undefined fields match anything. Handlers can call
         * ctx.setState / ctx.registerComponent in response to drive UI
         * updates without a chat round-trip.
         */
        onEvent(
          match: AethonEventMatch,
          handler: (event: AethonEventInfo, ctx: AethonEventCtx) => void | Promise<void>,
        ): void;
      }
    | undefined;
}

export {};
