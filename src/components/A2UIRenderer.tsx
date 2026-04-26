/**
 * A2UI Renderer
 * Renders A2UI component trees as React components with data binding and event dispatch
 */

import { invoke } from "@tauri-apps/api/core";
import type { A2UIComponent, A2UIPayload } from "../types/a2ui";
import { Button, Card, Code, Container, Text, TextInput } from "./builtins";

interface A2UIRendererProps {
  payload: A2UIPayload;
}

// Component registry mapping A2UI type names to React components
const COMPONENT_REGISTRY: Record<
  string,
  React.ComponentType<{
    component: A2UIComponent;
    state: Record<string, unknown>;
    onEvent: (componentId: string, eventType: string, data?: unknown) => void;
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
  const state = payload.state || {};

  /**
   * Handles events from A2UI components and routes them to the agent
   */
  const handleEvent = async (
    componentId: string,
    eventType: string,
    data?: unknown,
  ) => {
    const event = {
      componentId,
      eventType,
      data,
    };

    try {
      // Send event to agent via Tauri command
      await invoke("dispatch_a2ui_event", { event: JSON.stringify(event) });
    } catch (err) {
      console.error("Failed to dispatch A2UI event:", err);
    }
  };

  /**
   * Recursively renders an A2UI component and its children
   */
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
        onEvent={handleEvent}
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
