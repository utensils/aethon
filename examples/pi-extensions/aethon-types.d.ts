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

interface AethonPiHandlerCtx {
  /**
   * Fire an LLM turn from the handler — the chat input UI updates the
   * same way it would for a user-typed message. Use this to wire
   * buttons / sidebar items to agent actions ("summarize git log",
   * "explain this file"). Rejects via a system notice if a prompt is
   * already in flight.
   */
  prompt(text: string): Promise<void>;
  /**
   * Push a system message into the chat history. Non-terminal — does
   * not toggle the waiting/Stop flags. Use for handler progress notes.
   */
  notify(message: string): void;
  /** Read-only session info: current model id and last 50 messages. */
  readonly session: {
    readonly model: string;
    readonly messages: ReadonlyArray<unknown>;
  };
  /**
   * AbortSignal that fires when the user presses Stop or a new chat
   * comes in. Pass to fetch / spawn / model calls so handler work
   * cancels with the rest of the turn. Undefined when the handler
   * fires outside an agent turn (most sidebar clicks).
   */
  readonly signal: AbortSignal | undefined;
}

interface AethonCanvasComponent {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

/**
 * Programmatic canvas push API — sugar over `setState("/canvas", ...)`.
 * Per-tab attribution mirrors `setState`: the handler-ctx variant pins
 * to the originating tab; the global `aethon.canvas` resolves attribution
 * via AsyncLocalStorage / current active turn.
 */
interface AethonCanvasApi {
  /** Replace the canvas with the given component (or array of components). */
  emit(
    components: AethonCanvasComponent | AethonCanvasComponent[],
  ): Promise<{ ok: boolean; error?: string }>;
  /** Push the given component(s) onto the end of the existing canvas list. */
  append(
    components: AethonCanvasComponent | AethonCanvasComponent[],
  ): Promise<{ ok: boolean; error?: string }>;
  /** Empty the canvas. */
  clear(): Promise<{ ok: boolean; error?: string }>;
  /**
   * Patch a subpath under `/canvas` — e.g. `patch("/components/0/props/title", "Indexing")`.
   * Leading slash is optional. Useful for streaming partial updates while
   * a turn is still in flight.
   */
  patch(
    subpath: string,
    value: unknown,
  ): Promise<{ ok: boolean; error?: string }>;
}

interface AethonEventCtx {
  setState(path: string, value: unknown): void;
  registerComponent(componentType: string, template: unknown): void;
  /** Pi-coding-agent surface scoped for UI handlers. */
  pi: AethonPiHandlerCtx;
  /** Tab-scoped canvas helper — writes inherit the originating tab. */
  canvas: AethonCanvasApi;
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

        /**
         * Replace the active layout payload wholesale. Same shape as
         * src/extensions/default-layout/layout.a2ui.json — A2UI tree plus
         * initial state. The frontend rerenders entirely from this.
         */
        setLayout(payload: unknown): void;

        /**
         * Patch the active layout at the given JSON Pointer path
         * without shipping a full replacement.
         */
        patchLayout(path: string, value: unknown): void;

        /**
         * Append (or replace by id) a section in the sidebar. Convenience
         * wrapper around setState that targets `/sidebar/extraSections`.
         * Section item clicks fire `select` events on the `sidebar`
         * component with `{sectionId, itemId}` data; route via onEvent.
         */
        registerSidebarSection(section: {
          id: string;
          title: string;
          items?: { id: string; label: string; active?: boolean }[];
        }): void;

        /**
         * Register (or replace by id) a color scheme. `vars` is a map of
         * CSS custom properties — keys must start with `--`, e.g.
         * `{ "--bg": "#001122", "--text": "#fff", "--accent": "#9af" }`.
         * The frontend injects `:root[data-theme="<id>"] { ... }` into a
         * <style> element keyed by id and adds the theme to the sidebar
         * Themes section. Switching themes goes through the same
         * `select` event the built-in dark/light items already use.
         */
        registerTheme(theme: {
          id: string;
          label?: string;
          vars: Record<string, string>;
        }): void;

        /**
         * In "builtin" mode, App.tsx handles events not intercepted by
         * registerEventRoute. In "extension" mode, every layout event
         * bypasses built-ins and is forwarded to aethon.onEvent handlers.
         */
        setEventRoutingMode(mode: "builtin" | "extension"): Promise<{
          ok: boolean;
          error?: string;
        }>;

        /**
         * Programmatic canvas push API. Lets handlers (or boot-time
         * extension code) replace, append to, clear, or patch the
         * `/canvas` slot without composing the wrapper envelope every
         * time. Attribution falls back through the same priority chain
         * setState uses (active turn → last-known active tab).
         */
        canvas: AethonCanvasApi;
      }
    | undefined;
}

export {};
