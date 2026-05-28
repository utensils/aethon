/**
 * ExtensionRegistry — runtime registry of extensions and the components they expose.
 *
 * Lookup is type-string → React component. The registry is shared via React
 * context (see `ExtensionRegistryProvider.tsx`) so nested A2UIRenderers
 * (e.g., inside ChatHistory or MainCanvas) see the same extension bindings without
 * prop-drilling.
 *
 * This file holds the class + hook only — keeping React component exports
 * (`ExtensionRegistryProvider`) in a separate file so Vite's react-refresh
 * lint rule treats this module as pure logic.
 */

import { createContext, useContext } from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { A2UIComponentImpl, A2UIExtension } from "./types";

export class ExtensionRegistry {
  private readonly extensions = new Map<string, A2UIExtension>();
  private readonly components = new Map<string, A2UIComponentImpl>();
  // Declarative A2UI subtree templates registered by extensions. Looked up
  // alongside `components` — the renderer prefers React components if both
  // are present, falling back to template expansion. Independent of the
  // `extensions` map because templates can be re-registered live without
  // affecting any React-component extensions.
  private readonly templates = new Map<string, unknown>();
  private readonly templateListeners = new Set<() => void>();

  register(extension: A2UIExtension): void {
    this.extensions.set(extension.name, extension);
    if (extension.components) {
      for (const [type, impl] of Object.entries(extension.components)) {
        this.components.set(type, impl);
      }
    }
  }

  unregister(name: string): void {
    const extension = this.extensions.get(name);
    if (!extension) return;
    if (extension.components) {
      for (const type of Object.keys(extension.components)) {
        if (this.components.get(type) === extension.components[type]) {
          this.components.delete(type);
        }
      }
    }
    this.extensions.delete(name);
  }

  resolve(type: string): A2UIComponentImpl | undefined {
    return this.components.get(type);
  }

  resolveTemplate(type: string): unknown | undefined {
    return this.templates.get(type);
  }

  // Replace the template registry wholesale. Called when the bridge sends
  // an `extension_components` snapshot — the bridge is the source of truth.
  setTemplates(templates: Record<string, unknown>): void {
    this.templates.clear();
    for (const [type, template] of Object.entries(templates)) {
      this.templates.set(type, template);
    }
    for (const fn of this.templateListeners) fn();
  }

  // Lets components subscribe to template-set changes so they re-render
  // when an extension registers (or hot-reloads) a new component type.
  onTemplatesChanged(fn: () => void): () => void {
    this.templateListeners.add(fn);
    return () => this.templateListeners.delete(fn);
  }

  list(): A2UIExtension[] {
    return [...this.extensions.values()];
  }

  // The "primary" layout is the most recently registered extension's layout.
  // Extensions without a layout are skipped.
  primaryLayout(): A2UIPayload | undefined {
    let last: A2UIPayload | undefined;
    for (const extension of this.extensions.values()) {
      if (extension.layout) last = extension.layout;
    }
    return last;
  }
}

export const ExtensionRegistryContext = createContext<ExtensionRegistry | null>(null);

export function useExtensionRegistry(): ExtensionRegistry {
  const reg = useContext(ExtensionRegistryContext);
  if (!reg) {
    throw new Error("useExtensionRegistry called outside ExtensionRegistryProvider");
  }
  return reg;
}
