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
          eventType,
          data,
        }),
      });
    } catch (err) {
      console.error("Failed to dispatch A2UI event:", err);
    }
  };

  const renderComponent = (component: A2UIComponent): React.ReactNode => {
    const Component =
      PRIMITIVE_REGISTRY[component.type] ?? registry.resolve(component.type);

    if (!Component) {
      // No React impl — try the extension template registry. Templates are
      // declarative A2UI subtrees registered by pi extensions via the
      // bridge; we expand them in place using the same renderer + state.
      const template = registry.resolveTemplate(component.type);
      if (template && typeof template === "object") {
        const tpl = template as A2UIComponent;
        // ALWAYS derive the expanded id from the host component, never
        // reuse the template's own id — otherwise multiple renderings of
        // the same template type collide on React keys and event ids.
        const expanded: A2UIComponent = {
          ...tpl,
          id: `${component.id}__tpl`,
        };
        return renderComponent(expanded);
      }
      console.warn(`Unknown A2UI component type: ${component.type}`);
      return null;
    }

    const renderChildren = component.children
      ? () =>
          component.children!.map((child) => (
            <div key={child.id}>{renderComponent(child)}</div>
          ))
      : undefined;

    const renderChild = (child: A2UIComponent) => renderComponent(child);

    return (
      <Component
        key={component.id}
        component={component}
        state={state}
        onEvent={(eventType, data) => handleEvent(component, eventType, data)}
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
