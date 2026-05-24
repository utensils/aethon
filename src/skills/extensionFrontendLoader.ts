/**
 * Extension frontend loader — evaluates `aethon.frontendEntry` JS bodies
 * shipped by extension packages and registers the React components they
 * produce in the SkillRegistry.
 *
 * Channel:
 *   bridge reads `<extension-package>/<frontendEntry>` and ships the file
 *   contents as a string in `extension_frontend_modules`. The frontend
 *   wraps the body with `new Function("React", "skill", code)` and
 *   runs it. The module body uses `skill.registerComponent(type, fn)`
 *   to add a React component under a custom A2UI type. That type can
 *   then appear in any A2UI payload as `{type: "<type>", props: …}`
 *   and be resolved through the SkillRegistry like a built-in.
 *
 * Trust model: same as bridge-side extension code. The user installed the
 * package; they trust it. No sandbox — `new Function` is essentially
 * eval. The threat model is "malicious npm package", which is
 * orthogonal to this channel (a malicious bridge-side extension could
 * already read disk, fork processes, etc).
 *
 * Re-evaluation: each `extension_frontend_modules` delta is wholesale —
 * the full set of modules replaces the previous set. Components
 * registered by a removed module are unregistered. Components from a
 * re-evaluated module replace the previous binding (so a hot-reload
 * picks up new code).
 */
import * as React from "react";
import type { ComponentType } from "react";
import type { BuiltinComponentProps } from "../components/A2UIRenderer";
import type { SkillRegistry } from "./SkillRegistry";

type ReactExports = typeof React;

export interface ExtensionFrontendModule {
  name: string;
  code: string;
}

interface FrontendModuleApi {
  /**
   * Register a React component under a custom A2UI type. Re-registering
   * the same type within one module replaces the previous binding;
   * across modules, last write wins (consistent with the existing
   * SkillRegistry semantics).
   */
  registerComponent(
    type: string,
    component: ComponentType<BuiltinComponentProps>,
  ): void;
  /** Mark nested text as copyable inside extension chrome. Extension
   *  React components are wrapped in non-selectable app chrome by
   *  default; use this for paths, ids, or output users should copy. */
  selectableProps(): { "data-selectable": string };
}

export interface LoadedFrontendModule {
  name: string;
  componentTypes: string[];
  error?: string;
}

/**
 * Evaluate a single extension frontend module body in isolation. Returns the
 * set of component types it registered. Throws are caught and returned as the
 * `error` field so one broken module doesn't abort the whole load.
 */
export function evaluateFrontendModule(
  module: ExtensionFrontendModule,
  registry: SkillRegistry,
): LoadedFrontendModule {
  const componentTypes: string[] = [];
  const components: Record<string, ComponentType<BuiltinComponentProps>> = {};
  const api: FrontendModuleApi = {
    registerComponent(type, component) {
      if (typeof type !== "string" || type.length === 0) {
        throw new Error(
          `extension[${module.name}].registerComponent: type must be a non-empty string`,
        );
      }
      if (typeof component !== "function") {
        throw new Error(
          `extension[${module.name}].registerComponent("${type}"): component must be a function`,
        );
      }
      components[type] = wrapExtensionComponent(module.name, type, component);
      if (!componentTypes.includes(type)) componentTypes.push(type);
    },
    selectableProps() {
      return { "data-selectable": "true" };
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function("React", "skill", module.code) as (
      React: ReactExports,
      skill: FrontendModuleApi,
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
  // surface handles the lifecycle. Module names are namespaced by their npm
  // package name, so collisions across modules are unlikely; an explicit
  // second registration of the same module name unregisters the prior set
  // (handled by the caller via `unregister(name)` first).
  registry.register({ name: frontendModuleKey(module.name), components });
  return { name: module.name, componentTypes };
}

function wrapExtensionComponent(
  moduleName: string,
  type: string,
  Component: ComponentType<BuiltinComponentProps>,
): ComponentType<BuiltinComponentProps> {
  function ExtensionComponentBoundary(props: BuiltinComponentProps) {
    return React.createElement(
      "div",
      {
        className: "ae-extension-component",
        "data-extension-module": moduleName,
        "data-extension-component": type,
      },
      React.createElement(Component, props),
    );
  }
  ExtensionComponentBoundary.displayName = `AethonExtension(${type})`;
  return ExtensionComponentBoundary;
}

/**
 * Stable registry-side key for an extension frontend module. Prefixed so it
 * can't collide with a built-in skill (e.g. `default-layout`) or a skill the
 * webview might register through `window.aethon.registerSkill`.
 */
export function frontendModuleKey(moduleName: string): string {
  return `ext:${moduleName}`;
}

/**
 * Apply the full `extension_frontend_modules` payload — wholesale replace,
 * but skip re-evaluating modules whose code hasn't changed since the
 * previous load.
 *
 * The startup path sends a `ready` followed by a `report` (which
 * triggers another `ready`), so the same module list arrives twice in
 * one webview lifetime. Without the skip-on-unchanged path, every
 * top-level side effect in a module (timers, DOM listeners,
 * style injection) would run twice, and a failing module would emit
 * duplicate system notices. Caller passes a name → code map so we
 * can hash-compare without recomputing the previous set's source.
 *
 * @param previous — name → code from the prior load (so we know what
 *   to unregister AND what's unchanged). Use the `name` returned by
 *   `LoadedFrontendModule` (NOT the registry key); this helper handles
 *   the prefix.
 */
export function reconcileFrontendModules(
  previous: ReadonlyMap<string, string>,
  next: ExtensionFrontendModule[],
  registry: SkillRegistry,
): {
  loaded: LoadedFrontendModule[];
  unregistered: string[];
  skipped: string[];
} {
  const nextByName = new Map(next.map((m) => [m.name, m]));
  const unregistered: string[] = [];
  for (const name of previous.keys()) {
    if (!nextByName.has(name)) {
      registry.unregister(frontendModuleKey(name));
      unregistered.push(name);
    }
  }
  const skipped: string[] = [];
  const toEval: ExtensionFrontendModule[] = [];
  for (const m of next) {
    if (previous.get(m.name) === m.code) {
      // Same name, byte-identical code — components are still in the
      // registry from the prior eval. No-op.
      skipped.push(m.name);
      continue;
    }
    toEval.push(m);
  }
  // Always unregister BEFORE re-registering so a re-evaluated module's
  // old components don't linger if the new evaluation fails midway.
  for (const m of toEval) {
    registry.unregister(frontendModuleKey(m.name));
  }
  const loaded = toEval.map((m) => evaluateFrontendModule(m, registry));
  return { loaded, unregistered, skipped };
}
