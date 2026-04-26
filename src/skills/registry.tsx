/**
 * SkillRegistry — runtime registry of skills and the components they expose.
 *
 * Lookup is type-string → React component. The registry is shared via React
 * context so nested A2UIRenderers (e.g., inside ChatHistory or MainCanvas) see
 * the same skill bindings without prop-drilling.
 */

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import type { A2UIPayload } from "../types/a2ui";
import type { A2UIComponentImpl, A2UISkill } from "./types";

export class SkillRegistry {
  private readonly skills = new Map<string, A2UISkill>();
  private readonly components = new Map<string, A2UIComponentImpl>();

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

const SkillRegistryContext = createContext<SkillRegistry | null>(null);

export function useSkillRegistry(): SkillRegistry {
  const reg = useContext(SkillRegistryContext);
  if (!reg) {
    throw new Error("useSkillRegistry called outside SkillRegistryProvider");
  }
  return reg;
}

export function SkillRegistryProvider({
  registry,
  children,
}: {
  registry: SkillRegistry;
  children: ReactNode;
}) {
  // Pin the registry instance per-mount so context consumers stay stable.
  const [pinned] = useState(() => registry);
  return (
    <SkillRegistryContext.Provider value={pinned}>
      {children}
    </SkillRegistryContext.Provider>
  );
}
