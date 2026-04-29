/**
 * Skill module loader — evaluates `aethon.frontendEntry` JS bodies
 * shipped by skill packages and registers the React components they
 * produce in the SkillRegistry.
 *
 * Channel:
 *   bridge reads `<skill-package>/<frontendEntry>` and ships the file
 *   contents as a string in `extension_skill_modules`. The frontend
 *   wraps the body with `new Function("React", "skill", code)` and
 *   runs it. The skill body uses `skill.registerComponent(type, fn)`
 *   to add a React component under a custom A2UI type. That type can
 *   then appear in any A2UI payload as `{type: "<type>", props: …}`
 *   and be resolved through the SkillRegistry like a built-in.
 *
 * Trust model: same as bridge-side skill code. The user installed the
 * package; they trust it. No sandbox — `new Function` is essentially
 * eval. The threat model is "malicious npm package", which is
 * orthogonal to this channel (a malicious bridge-side skill could
 * already read disk, fork processes, etc).
 *
 * Re-evaluation: each `extension_skill_modules` delta is wholesale —
 * the full set of skills replaces the previous set. Components
 * registered by a removed skill are unregistered. Components from a
 * re-evaluated skill replace the previous binding (so a hot-reload
 * picks up new code).
 */
import * as React from "react";
import type { ComponentType } from "react";
import type { BuiltinComponentProps } from "../components/A2UIRenderer";
import type { SkillRegistry } from "./SkillRegistry";

type ReactExports = typeof React;

export interface SkillModule {
  name: string;
  code: string;
}

interface SkillEvalApi {
  /**
   * Register a React component under a custom A2UI type. Re-registering
   * the same type within one skill replaces the previous binding;
   * across skills, last write wins (consistent with the existing
   * SkillRegistry semantics).
   */
  registerComponent(
    type: string,
    component: ComponentType<BuiltinComponentProps>,
  ): void;
}

export interface LoadedSkillModule {
  name: string;
  componentTypes: string[];
  error?: string;
}

/**
 * Evaluate a single skill module body in isolation. Returns the set of
 * component types it registered. Throws are caught and returned as the
 * `error` field so one broken skill doesn't abort the whole load.
 */
export function evaluateSkillModule(
  module: SkillModule,
  registry: SkillRegistry,
): LoadedSkillModule {
  const componentTypes: string[] = [];
  const components: Record<string, ComponentType<BuiltinComponentProps>> = {};
  const api: SkillEvalApi = {
    registerComponent(type, component) {
      if (typeof type !== "string" || type.length === 0) {
        throw new Error(
          `skill[${module.name}].registerComponent: type must be a non-empty string`,
        );
      }
      if (typeof component !== "function") {
        throw new Error(
          `skill[${module.name}].registerComponent("${type}"): component must be a function`,
        );
      }
      components[type] = component;
      if (!componentTypes.includes(type)) componentTypes.push(type);
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function("React", "skill", module.code) as (
      React: ReactExports,
      skill: SkillEvalApi,
    ) => void;
    factory(React, api);
  } catch (err) {
    return {
      name: module.name,
      componentTypes,
      error: (err as Error).message ?? String(err),
    };
  }
  // Synthesize an A2UISkill so the registry's existing register/unregister
  // surface handles the lifecycle. Skill module names are namespaced by
  // their npm package name, so collisions across modules are unlikely;
  // an explicit second registration of the same skill name unregisters
  // the prior set (handled by the caller via `unregister(name)` first).
  registry.register({ name: skillRegistryName(module.name), components });
  return { name: module.name, componentTypes };
}

/**
 * Stable registry-side name for a skill module. Prefixed so it can't
 * collide with a built-in skill (e.g. `default-layout`) or a skill the
 * webview might register through `window.aethon.registerSkill`.
 */
export function skillRegistryName(moduleName: string): string {
  return `frontend:${moduleName}`;
}

/**
 * Apply the full `extension_skill_modules` payload — wholesale replace.
 * Removes any previously-loaded modules that aren't in the new list,
 * then evaluates the new ones.
 *
 * @param previous — names from the prior load (so we know what to unregister).
 *   Use the `name` returned by `LoadedSkillModule` (NOT the registry
 *   name); this helper handles the prefix.
 */
export function reconcileSkillModules(
  previous: ReadonlySet<string>,
  next: SkillModule[],
  registry: SkillRegistry,
): { loaded: LoadedSkillModule[]; unregistered: string[] } {
  const nextNames = new Set(next.map((m) => m.name));
  const unregistered: string[] = [];
  for (const name of previous) {
    if (!nextNames.has(name)) {
      registry.unregister(skillRegistryName(name));
      unregistered.push(name);
    }
  }
  // Always unregister BEFORE re-registering so a re-evaluated skill's
  // old components don't linger if the new evaluation fails midway.
  for (const m of next) {
    registry.unregister(skillRegistryName(m.name));
  }
  const loaded = next.map((m) => evaluateSkillModule(m, registry));
  return { loaded, unregistered };
}
