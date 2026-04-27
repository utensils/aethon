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
      }
    | undefined;
}

export {};
