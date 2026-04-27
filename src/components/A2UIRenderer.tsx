/**
 * A2UI Renderer
 * Renders A2UI component trees as React components with data binding and event
 * dispatch. Built-in A2UI primitives (text, card, button, …) are hardcoded;
 * skill-registered components (sidebar, terminal, layout, …) come from the
 * SkillRegistry pulled in via context, so nested renderers see the same
 * bindings without prop-drilling.
 */

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIComponent, A2UIPayload } from "../types/a2ui";
import { isDynamicRef, setPointer } from "../utils/jsonPointer";
import { useSkillRegistry } from "../skills/registry";
import { Button, Card, Code, Container, Image, Text, TextInput } from "./builtins";

export type A2UIEventHandler = (
  component: A2UIComponent,
  eventType: string,
  data?: unknown,
) => boolean | Promise<boolean> | void | Promise<void>;

interface A2UIRendererProps {
  payload: A2UIPayload;
  // Optional state setter — when supplied, the renderer mutates this caller-owned
  // store (chat input, draft, etc.) instead of its internal copy. This is what
  // lets the App treat the layout's state as the single source of truth.
  state?: Record<string, unknown>;
  onStateChange?: (next: Record<string, unknown>) => void;
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
  onEvent: (eventType: string, data?: unknown) => void;
  renderChildren?: () => React.ReactNode;
  renderChild?: (child: A2UIComponent) => React.ReactNode;
}

// A2UI primitives — always available, can't be overridden by skills.
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

const PRIMITIVE_REGISTRY: Record<
  string,
  React.ComponentType<BuiltinComponentProps>
> = {
  text: Text,
  card: Card,
  button: Button,
  container: Container,
  code: Code,
  image: Image,
  "text-input": TextInput,
};

export default function A2UIRenderer({
  payload,
  state: externalState,
  onStateChange,
  onEvent: externalOnEvent,
  tabId,
}: A2UIRendererProps) {
  const registry = useSkillRegistry();
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
      onStateChange!(updater(externalState as Record<string, unknown>));
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
    setInternalState(payload.state || {});
  }, [payload, mode]);

  const handleEvent = async (
    component: A2UIComponent,
    eventType: string,
    data?: unknown,
    templateRootType?: string,
  ) => {
    updateState((prev) => applyOptimisticUpdate(prev, component, eventType, data));

    if (externalOnEvent) {
      const handled = await externalOnEvent(component, eventType, data);
      if (handled) return;
    }

    try {
      await invoke("dispatch_a2ui_event", {
        event: JSON.stringify({
          componentId: component.id,
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
  ): React.ReactNode => {
    const Component =
      PRIMITIVE_REGISTRY[component.type] ?? registry.resolve(component.type);

    if (!Component) {
      // No React impl — try the extension template registry. Templates are
      // declarative A2UI subtrees registered by pi extensions via the
      // bridge; we expand them in place using the same renderer + state.
      const template = registry.resolveTemplate(component.type);
      if (template && typeof template === "object") {
        const tpl = template as A2UIComponent;
        // Rewrite EVERY id in the template tree to be host-prefixed so
        // multiple renderings don't collide on React keys nor on event
        // componentIds (events from interactive children would otherwise
        // be ambiguous between instances).
        const expanded = rewriteTemplateIds(tpl, `${component.id}__tpl`);
        // Track the host template type so descendants' events carry it —
        // extension handlers register by template type to filter events
        // from their own template instances.
        return renderComponent(expanded, component.type);
      }
      console.warn(`Unknown A2UI component type: ${component.type}`);
      return null;
    }

    const renderChildren = component.children
      ? () =>
          component.children!.map((child) => (
            <div key={child.id}>{renderComponent(child, templateRootType)}</div>
          ))
      : undefined;

    const renderChild = (child: A2UIComponent) =>
      renderComponent(child, templateRootType);

    return (
      <Component
        key={component.id}
        component={component}
        state={state}
        onEvent={(eventType, data) =>
          handleEvent(component, eventType, data, templateRootType)
        }
        renderChildren={renderChildren}
        renderChild={renderChild}
      />
    );
  };

  return (
    <div className="a2ui-renderer">
      {payload.components.map((component) => renderComponent(component))}
    </div>
  );
}
