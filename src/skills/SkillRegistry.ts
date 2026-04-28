/**
 * SkillRegistry — runtime registry of skills and the components they expose.
 *
 * Lookup is type-string → React component. The registry is shared via React
 * context (see `registry.tsx`) so nested A2UIRenderers (e.g., inside
 * ChatHistory or MainCanvas) see the same skill bindings without
 * prop-drilling.
 *
 * This file holds the class + hook only — keeping React component exports
 * (`SkillRegistryProvider`) in a separate file so Vite's react-refresh
 * lint rule treats this module as pure logic.
 */

import { createContext, useContext } from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { A2UIComponentImpl, A2UISkill } from "./types";

export class SkillRegistry {
  private readonly skills = new Map<string, A2UISkill>();
  private readonly components = new Map<string, A2UIComponentImpl>();
  // Declarative A2UI subtree templates registered by extensions. Looked up
  // alongside `components` — the renderer prefers React components if both
  // are present, falling back to template expansion. Independent of the
  // `skills` map because templates can be re-registered live without
  // affecting any React-component skills.
  private readonly templates = new Map<string, unknown>();
  private readonly templateListeners = new Set<() => void>();

  register(skill: A2UISkill): void {
    this.skills.set(skill.name, skill);
    if (skill.components) {
      for (const [type, impl] of Object.entries(skill.components)) {
        this.components.set(type, impl);
      }
    }
  }

  unregister(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;
    if (skill.components) {
      for (const type of Object.keys(skill.components)) {
        if (this.components.get(type) === skill.components[type]) {
          this.components.delete(type);
        }
      }
    }
    this.skills.delete(name);
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

  list(): A2UISkill[] {
    return [...this.skills.values()];
  }

  // The "primary" layout is the most recently registered skill's layout.
  // Skills without a layout are skipped.
  primaryLayout(): A2UIPayload | undefined {
    let last: A2UIPayload | undefined;
    for (const skill of this.skills.values()) {
      if (skill.layout) last = skill.layout;
    }
    return last;
  }
}

export const SkillRegistryContext = createContext<SkillRegistry | null>(null);

export function useSkillRegistry(): SkillRegistry {
  const reg = useContext(SkillRegistryContext);
  if (!reg) {
    throw new Error("useSkillRegistry called outside SkillRegistryProvider");
  }
  return reg;
}
