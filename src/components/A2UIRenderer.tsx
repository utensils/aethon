/**
 * A2UI Renderer
 * Renders A2UI component trees as React components with data binding and event dispatch
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { A2UIComponent, A2UIPayload } from "../types/a2ui";
import { isDynamicRef, setPointer } from "../utils/jsonPointer";
import { Button, Card, Code, Container, Text, TextInput } from "./builtins";

interface A2UIRendererProps {
  payload: A2UIPayload;
}

/**
 * Optimistically merges a UI-emitted event into local state so controlled
 * inputs stay responsive while the agent is the source of truth.
 *
 * The agent will eventually send back an authoritative state update; until
 * then, this lets the user see their own typing/clicks reflected.
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

// Component registry mapping A2UI type names to React components
const COMPONENT_REGISTRY: Record<
  string,
  React.ComponentType<{
    component: A2UIComponent;
    state: Record<string, unknown>;
    onEvent: (eventType: string, data?: unknown) => void;
    renderChildren?: () => React.ReactNode;
  }>
> = {
  text: Text,
  card: Card,
  button: Button,
  container: Container,
  code: Code,
  "text-input": TextInput,
};

export default function A2UIRenderer({ payload }: A2UIRendererProps) {
  const [state, setState] = useState<Record<string, unknown>>(
    payload.state || {},
  );

  // Re-sync when the agent ships a new payload (authoritative state wins).
  useEffect(() => {
    setState(payload.state || {});
  }, [payload]);

  const handleEvent = async (
    component: A2UIComponent,
    eventType: string,
    data?: unknown,
  ) => {
    setState((prev) => applyOptimisticUpdate(prev, component, eventType, data));

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
    const Component = COMPONENT_REGISTRY[component.type];

    if (!Component) {
      console.warn(`Unknown A2UI component type: ${component.type}`);
      return null;
    }

    const renderChildren = component.children
      ? () => component.children!.map((child) => (
          <div key={child.id}>{renderComponent(child)}</div>
        ))
      : undefined;

    return (
      <Component
        key={component.id}
        component={component}
        state={state}
        onEvent={(eventType, data) => handleEvent(component, eventType, data)}
        renderChildren={renderChildren}
      />
    );
  };

  return (
    <div className="a2ui-renderer">
      {payload.components.map((component) => (
        <div key={component.id} style={{ marginBottom: "12px" }}>
          {renderComponent(component)}
        </div>
      ))}
    </div>
  );
}
