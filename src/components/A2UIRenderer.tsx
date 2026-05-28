/**
 * A2UI Renderer
 * Renders A2UI component trees as React components with data binding and event
 * dispatch. Built-in A2UI primitives (text, card, button, …) are hardcoded;
 * extension-registered components (sidebar, terminal, layout, …) come from the
 * ExtensionRegistry pulled in via context, so nested renderers see the same
 * bindings without prop-drilling.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIComponent, A2UIPayload } from "../types/a2ui";
import { isDynamicRef, resolvePointer, setPointer } from "../utils/jsonPointer";
import { useExtensionRegistry } from "../extensions/ExtensionRegistry";
import {
  Button,
  Card,
  Checkbox,
  Code,
  Container,
  DatePicker,
  Divider,
  Form,
  FormField,
  Heading,
  Icon,
  Image,
  List,
  Paragraph,
  Select,
  Slider,
  Table,
  Text,
  TextInput,
} from "./builtins";

export type A2UIEventHandler = (
  component: A2UIComponent,
  eventType: string,
  data?: unknown,
) => boolean | Promise<boolean> | void | Promise<void>;

interface A2UIRendererProps {
  payload: A2UIPayload;
  // When true, render the components as a Fragment instead of wrapping
  // them in `<div class="a2ui-renderer">`. The wrapper has global
  // `flex: 1; overflow: hidden` styles that are correct for the main
  // layout-payload mount but break leaf renders (e.g. RegistryComponent
  // mounting an overlay or the share-mode badge inline in a status bar):
  // the wrapper would otherwise consume flex space alongside the real
  // layout. Used by RegistryComponent below.
  bare?: boolean;
  // Optional state setter — when supplied, the renderer mutates this caller-owned
  // store (chat input, draft, etc.) instead of its internal copy. This is what
  // lets the App treat the layout's state as the single source of truth.
  state?: Record<string, unknown>;
  onStateChange?: (
    next:
      | Record<string, unknown>
      | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ) => void;
  // Intercept events before (or instead of) the default Tauri dispatch.
  // Return true to indicate the event was handled — prevents agent forwarding.
  onEvent?: A2UIEventHandler;
  // Tab the rendered tree belongs to. Threaded into dispatch_a2ui_event so
  // the bridge routes handler-fired pi prompts back to the right session
  // (otherwise non-default tabs would always trigger the default tab).
  tabId?: string;
}

/**
 * Optimistically merges a UI-emitted event into local state so controlled
 * inputs stay responsive while the agent is the source of truth.
 */
function applyOptimisticUpdate(
  prev: Record<string, unknown>,
  component: A2UIComponent,
  eventType: string,
  data: unknown,
): Record<string, unknown> {
  if (eventType !== "change" && eventType !== "submit") return prev;

  const valueProp = component.props?.value;
  if (!isDynamicRef(valueProp)) return prev;

  const next = (data as { value?: unknown } | undefined)?.value;
  if (next === undefined) return prev;

  return setPointer(prev, valueProp.$ref, next);
}

export interface BuiltinComponentProps {
  component: A2UIComponent;
  state: Record<string, unknown>;
  // descendantId lets composites that render their own per-row controls
  // (sidebar items, list rows) emit an event tagged with a stable child
  // id so extension `onEvent({componentType:"sidebar-item", descendantId})`
  // matchers can target a specific row. The renderer rewrites the
  // outbound componentId to `<componentId>__tpl__<descendantId>` so the
  // bridge's existing __tpl__ separator parsing produces that descendantId.
  onEvent: (eventType: string, data?: unknown, descendantId?: string) => void;
  renderChildren?: () => React.ReactNode;
  renderChild?: (child: A2UIComponent) => React.ReactNode;
  // Composites that want to expand a registered template per-row (sidebar
  // with item-level componentType, list/table cells) get a renderer that
  // accepts an extra state overlay. The overlay merges over the active
  // state, so descendant `$ref`s see iteration locals like /$item /
  // /$index — same shape as the for-each primitive's scope keys.
  renderChildWithState?: (
    child: A2UIComponent,
    overlay: Record<string, unknown>,
  ) => React.ReactNode;
  // Tab the component lives on. Components that nest their own
  // A2UIRenderer (e.g. ChatHistory rendering a tool card's payload)
  // forward this so events from inside the card route to the
  // correct pi session, not whatever tab happens to be "default".
  tabId?: string;
}

// A2UI primitives — always available, can't be overridden by extensions.
// Recursively prefix every component id in an extension template subtree
// with the host instance's id. Used when expanding a template so multiple
// instances don't share React keys or emit ambiguous event componentIds.
function rewriteTemplateIds(node: A2UIComponent, prefix: string): A2UIComponent {
  const out: A2UIComponent = {
    ...node,
    id: node.id ? `${prefix}__${node.id}` : prefix,
  };
  if (node.children && node.children.length > 0) {
    out.children = node.children.map((c) => rewriteTemplateIds(c, prefix));
  }
  return out;
}

// Suffix every id in a subtree with `__$idx<n>` so React keys stay
// stable across N iterations of a for-each expansion. Without this all
// rows would share the same key and clicks/events would be ambiguous.
function suffixIds(node: A2UIComponent, suffix: string): A2UIComponent {
  const out: A2UIComponent = {
    ...node,
    id: node.id ? `${node.id}${suffix}` : suffix,
  };
  if (node.children && node.children.length > 0) {
    out.children = node.children.map((c) => suffixIds(c, suffix));
  }
  return out;
}

const PRIMITIVE_REGISTRY: Record<
  string,
  React.ComponentType<BuiltinComponentProps>
> = {
  text: Text,
  heading: Heading,
  paragraph: Paragraph,
  card: Card,
  button: Button,
  container: Container,
  divider: Divider,
  code: Code,
  image: Image,
  icon: Icon,
  "text-input": TextInput,
  "date-picker": DatePicker,
  select: Select,
  checkbox: Checkbox,
  slider: Slider,
  form: Form,
  "form-field": FormField,
  list: List,
  table: Table,
};

// Mount a registry-resolved component as a leaf at the app root. Used for
// overlays (command-palette, notification-stack, settings-panel,
// search-panel, share-mode-badge) so an extension can replace them via
// `aethon.registerComponent("<type>", custom)` — without this helper the
// overlays would have to be direct-imported, which bypasses the registry
// and silently defeats the documented override path.
//
// Implementation: synthesize a one-component A2UI payload and run it
// through the main renderer. That gets template/React/primitive lookup
// priority right (templates from `aethon.registerComponent` win over
// default extension components), automatically. Callers with a need to
// pass live data into the synthetic root use `componentProps` —
// shareMode/tabId for the share badge is the canonical example.
export function RegistryComponent({
  type,
  state,
  onEvent,
  componentProps,
  tabId,
}: {
  type: string;
  state: Record<string, unknown>;
  onEvent: A2UIEventHandler;
  componentProps?: Record<string, unknown>;
  // Tab id forwarded into the inner renderer's event dispatch. Critical
  // for App-root overlays — without this, an extension that replaces
  // command-palette / search-panel / settings-panel / notification-stack
  // with a declarative template emits events that the bridge defaults
  // to tabId="default", routing extension handlers / ctx.pi.prompt()
  // against the wrong pi session in any non-default active tab.
  tabId?: string;
}) {
  const payload = useMemo<A2UIPayload>(
    () => ({
      components: [{ id: type, type, props: componentProps ?? {} }],
    }),
    [type, componentProps],
  );
  return (
    <A2UIRenderer
      payload={payload}
      state={state}
      onEvent={onEvent}
      tabId={tabId}
      bare
    />
  );
}

export default function A2UIRenderer({
  payload,
  state: externalState,
  onStateChange,
  onEvent: externalOnEvent,
  tabId,
  bare = false,
}: A2UIRendererProps) {
  const registry = useExtensionRegistry();
  const [internalState, setInternalState] = useState<Record<string, unknown>>(
    payload.state || {},
  );
  // Bump on extension template registry changes so the renderer re-evaluates
  // any `<Unknown>` types into newly-registered templates without unmounting.
  const [, setTemplateVersion] = useState(0);
  useEffect(() => {
    return registry.onTemplatesChanged(() => setTemplateVersion((n) => n + 1));
  }, [registry]);

  // Three rendering modes, each with different state semantics:
  //   - controlled: caller provides both `state` and `onStateChange`. The
  //     external state is the single source of truth (root layout).
  //     payload.state is NOT merged — that would shadow live app state
  //     with stale boot defaults on every render.
  //   - observer:   caller provides `state` but no `onStateChange` (nested
  //     A2UI inside a chat message). External state = read-only base of
  //     globals (extension state, theme). payload.state seeds an internal
  //     write overlay so the agent's per-message locals (and optimistic
  //     change/submit writes) survive without leaking into app state.
  //   - self:       no external — renderer fully owns internalState,
  //     seeded from payload.state. Used for standalone embedded renders.
  const mode = onStateChange
    ? "controlled"
    : externalState
      ? "observer"
      : "self";

  const state = useMemo(() => {
    if (mode === "controlled") return externalState as Record<string, unknown>;
    if (mode === "observer") {
      return { ...(externalState as Record<string, unknown>), ...internalState };
    }
    return internalState;
  }, [mode, externalState, internalState]);

  const updateState = (
    updater: (prev: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (mode === "controlled") {
      // Pass the updater to React's setState so it composes against the
      // LATEST committed state, not `externalState` from the render
      // closure. Without this, two events firing back-to-back from
      // outside React (e.g. document-level mousemove then mouseup
      // during a sidebar resize) both run with the same stale snapshot
      // — the second event's no-op optimistic update silently reverts
      // the first event's real mutation.
      onStateChange!((prev) => updater(prev));
    } else if (mode === "observer") {
      // Compute the post-update merged state, then DIFF against the parent
      // external state so internalState only retains keys that diverge.
      // Without the diff, snapshotted external keys would freeze in
      // internal and shadow future global updates (e.g. extension
      // state_patch values arriving after a local click).
      //
      // Known limitation: the diff is top-level only. If a chat-card
      // text-input writes `/foo/bar` while extension state ALSO writes
      // under `/foo/...`, the entire `foo` subtree freezes in the
      // overlay and live extension updates to siblings stop reflecting
      // in this card. The contrived collision (extension key namespace
      // overlapping with a card-local input path) is unlikely in
      // practice; deeper-path tracking would require threading the
      // optimistic-update path out of applyOptimisticUpdate.
      setInternalState((prev) => {
        const ext = externalState as Record<string, unknown>;
        const merged = { ...ext, ...prev };
        const next = updater(merged);
        const diff: Record<string, unknown> = {};
        for (const k of Object.keys(next)) {
          if (!Object.is(next[k], ext[k])) diff[k] = next[k];
        }
        return diff;
      });
    } else {
      setInternalState(updater);
    }
  };

  // Re-sync when the agent ships a new payload. In `self` mode the new
  // payload.state replaces internal state. In `observer` mode (nested
  // chat card with no upward write channel) the overlay is reseeded from
  // the new payload.state — without this, replacing a tool card by id
  // (running → done) would keep showing the old payload's bindings even
  // though the payload prop changed. `controlled` mode owns no internal
  // state to reset.
  useEffect(() => {
    if (mode === "controlled") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInternalState(payload.state || {});
  }, [payload, mode]);

  const handleEvent = async (
    component: A2UIComponent,
    eventType: string,
    data?: unknown,
    templateRootType?: string,
    descendantId?: string,
  ) => {
    updateState((prev) => applyOptimisticUpdate(prev, component, eventType, data));

    if (externalOnEvent) {
      const handled = await externalOnEvent(component, eventType, data);
      if (handled) return;
    }

    // When a composite emits a per-row event with descendantId, rewrite
    // the outbound componentId to include the standard __tpl__ separator
    // so the bridge's a2ui_event parser pulls it into match.descendantId
    // exactly as it does for template-expanded children.
    const outboundComponentId = descendantId
      ? `${component.id}__tpl__${descendantId}`
      : component.id;

    try {
      await invoke("dispatch_a2ui_event", {
        event: JSON.stringify({
          componentId: outboundComponentId,
          // Carry the rendered component's type so extension a2ui_event
          // handlers can match on it without parsing the id. For template-
          // expanded children, this is the inner type (e.g. "button").
          componentType: component.type,
          // When the event fires inside an expanded template, also include
          // the template's outer type ("clock-card") so handlers can match
          // by host without enumerating descendant types.
          templateRootType,
          eventType,
          data,
        }),
        tabId,
      });
    } catch (err) {
      console.error("Failed to dispatch A2UI event:", err);
    }
  };

  const renderComponent = (
    component: A2UIComponent,
    templateRootType?: string,
    scopedState?: Record<string, unknown>,
  ): React.ReactNode => {
    // for-each: expand `children` once per element in `props.items`.
    // The bound state for each iteration adds three keys consumable by
    // nested $refs:
    //   /$item   — current array element
    //   /$index  — 0-based position
    //   /$parent — the surrounding state (the same `state` outside scope)
    // Use these from a child as `{ $ref: "/$item/label" }`.
    if (component.type === "for-each") {
      const props = component.props as
        | { items?: unknown; key?: string }
        | undefined;
      let items: unknown = props?.items;
      // Resolve $ref through the active state so the items can be
      // bound to the global store (e.g. /sidebar/models).
      if (isDynamicRef(items)) {
        items = resolvePointer(scopedState ?? state, items.$ref);
      }
      if (!Array.isArray(items) || items.length === 0) return null;
      const childTemplates = component.children ?? [];
      const keyProp = props?.key;
      const baseState = scopedState ?? state;
      return items.map((item, index) => {
        // Augment the surrounding state with the iteration locals. The
        // resolver finds them via standard JSON Pointer lookup.
        const iterState: Record<string, unknown> = {
          ...baseState,
          $item: item,
          $index: index,
          $parent: baseState,
        };
        // Pick a stable React key — explicit prop on the item wins,
        // otherwise the index (rows can re-order at the cost of
        // mounting/unmounting child controls).
        const key =
          keyProp && item && typeof item === "object" && keyProp in (item as object)
            ? String((item as Record<string, unknown>)[keyProp])
            : String(index);
        return (
          <div key={key}>
            {childTemplates.map((child) =>
              renderComponent(
                suffixIds(child, `__$idx${index}`),
                templateRootType,
                iterState,
              ),
            )}
          </div>
        );
      });
    }

    // Use the iteration-augmented state if we're inside a for-each;
    // otherwise the renderer's own state.
    const activeState = scopedState ?? state;

    // Lookup priority — primitives are immutable; for everything else,
    // extension-registered templates beat the default React component
    // so `aethon.registerComponent("<type>", template)` from the bridge
    // is a real override surface (otherwise built-in extensions always win
    // and the documented override is silently dead). Extension-registered
    // React components remain the default.
    const Primitive = PRIMITIVE_REGISTRY[component.type];
    if (!Primitive) {
      const template = registry.resolveTemplate(component.type);
      if (template && typeof template === "object") {
        const tpl = template as A2UIComponent;
        // Rewrite EVERY id in the template tree to be host-prefixed so
        // multiple renderings don't collide on React keys nor on event
        // componentIds (events from interactive children would otherwise
        // be ambiguous between instances).
        const expanded = rewriteTemplateIds(tpl, `${component.id}__tpl`);
        // Expose the host component's props inside the scoped state as
        // `$props` so the template can `$ref: "/$props/<key>"` to read
        // live values from the host. Without this, a declarative override
        // for a component like `share-mode-badge` (which carries a live
        // `{shareMode, tabId}` from the parent) loses access to those
        // values — the React-component override path passes them via
        // `component.props`, so the template path needs an equivalent.
        const hostProps =
          component.props && typeof component.props === "object"
            ? component.props
            : {};
        const baseScope = scopedState ?? activeState;
        const templateScope: Record<string, unknown> = {
          ...baseScope,
          $props: hostProps,
        };
        // Track the host template type so descendants' events carry it —
        // extension handlers register by template type to filter events
        // from their own template instances.
        return renderComponent(expanded, component.type, templateScope);
      }
    }
    const Component = Primitive ?? registry.resolve(component.type);
    if (!Component) {
      console.warn(`Unknown A2UI component type: ${component.type}`);
      return null;
    }

    const renderChildren = component.children
      ? () =>
          component.children!.map((child) => (
            <Fragment key={child.id}>
              {renderComponent(child, templateRootType, scopedState)}
            </Fragment>
          ))
      : undefined;

    const renderChild = (child: A2UIComponent) =>
      renderComponent(child, templateRootType, scopedState);

    const renderChildWithState = (
      child: A2UIComponent,
      overlay: Record<string, unknown>,
    ) => renderComponent(child, templateRootType, { ...activeState, ...overlay });

    return (
      <Component
        key={component.id}
        component={component}
        state={activeState}
        onEvent={(eventType, data, descendantId) =>
          handleEvent(component, eventType, data, templateRootType, descendantId)
        }
        renderChildren={renderChildren}
        renderChild={renderChild}
        renderChildWithState={renderChildWithState}
        tabId={tabId}
      />
    );
  };

  if (bare) {
    return (
      <Fragment>
        {payload.components.map((component) => (
          <Fragment key={component.id}>{renderComponent(component)}</Fragment>
        ))}
      </Fragment>
    );
  }
  return (
    <div className="a2ui-renderer">
      {payload.components.map((component) => renderComponent(component))}
    </div>
  );
}
