/**
 * A2UI Renderer
 * Renders A2UI component trees as React components with data binding and event
 * dispatch. Built-in A2UI primitives (text, card, button, …) are hardcoded;
 * skill-registered components (sidebar, terminal, layout, …) come from the
 * SkillRegistry pulled in via context, so nested renderers see the same
 * bindings without prop-drilling.
 */

import { useEffect, useState } from "react";
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

  // External state wins when the caller is driving state. Otherwise we own it.
  const state = externalState ?? internalState;
  const updateState = (
    updater: (prev: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (externalState && onStateChange) {
      onStateChange(updater(externalState));
    } else {
      setInternalState(updater);
    }
  };

  // Re-sync when the agent ships a new payload (authoritative state wins).
  useEffect(() => {
    if (!externalState) {
      setInternalState(payload.state || {});
    }
  }, [payload, externalState]);

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
