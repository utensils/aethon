import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry } from "./SkillRegistry";
import {
  evaluateFrontendModule,
  reconcileFrontendModules,
  frontendModuleKey,
} from "./extensionFrontendLoader";

describe("evaluateFrontendModule", () => {
  let registry: SkillRegistry;
  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it("registers a component declared in the module body", () => {
    const code = `
      skill.registerComponent("test-card", function TestCard({ component }) {
        return React.createElement("div", { "data-testid": "tc" }, component.id);
      });
    `;
    const result = evaluateFrontendModule({ name: "test-ext", code }, registry);
    expect(result.error).toBeUndefined();
    expect(result.componentTypes).toEqual(["test-card"]);
    expect(registry.resolve("test-card")).toBeDefined();
  });

  it("captures errors instead of throwing so one bad module can't kill others", () => {
    const code = `throw new Error("boom");`;
    const result = evaluateFrontendModule({ name: "broken", code }, registry);
    expect(result.error).toContain("boom");
    expect(registry.resolve("anything")).toBeUndefined();
  });

  it("rejects non-string types with a helpful error", () => {
    const code = `skill.registerComponent(42, function () {});`;
    const result = evaluateFrontendModule({ name: "bad-types", code }, registry);
    expect(result.error).toContain("type must be a non-empty string");
  });

  it("rejects non-function components with a helpful error", () => {
    const code = `skill.registerComponent("oops", "not a function");`;
    const result = evaluateFrontendModule({ name: "bad-comp", code }, registry);
    expect(result.error).toContain("component must be a function");
  });

  it("namespaces the module in the registry under `ext:<name>`", () => {
    const code = `skill.registerComponent("ns", function () { return null; });`;
    evaluateFrontendModule({ name: "my-ext", code }, registry);
    const skills = registry.list().map((s) => s.name);
    expect(skills).toContain(frontendModuleKey("my-ext"));
  });

  it("exposes React.createElement and hooks to the module body", () => {
    const code = `
      const { createElement, useEffect } = React;
      if (typeof createElement !== "function") {
        throw new Error("createElement missing");
      }
      if (typeof useEffect !== "function") {
        throw new Error("useEffect missing");
      }
      skill.registerComponent("hooks-ok", function () {
        return createElement("span", null, "ok");
      });
    `;
    const result = evaluateFrontendModule({ name: "hook-test", code }, registry);
    expect(result.error).toBeUndefined();
    expect(result.componentTypes).toEqual(["hooks-ok"]);
  });
});

describe("reconcileFrontendModules", () => {
  let registry: SkillRegistry;
  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it("loads new modules and tracks their names", () => {
    const { loaded, unregistered, skipped } = reconcileFrontendModules(
      new Map<string, string>(),
      [
        {
          name: "alpha",
          code: `skill.registerComponent("a", function () { return null; });`,
        },
        {
          name: "beta",
          code: `skill.registerComponent("b", function () { return null; });`,
        },
      ],
      registry,
    );
    expect(loaded.map((l) => l.name)).toEqual(["alpha", "beta"]);
    expect(unregistered).toEqual([]);
    expect(skipped).toEqual([]);
    expect(registry.resolve("a")).toBeDefined();
    expect(registry.resolve("b")).toBeDefined();
  });

  it("unregisters modules that disappear from the next delta", () => {
    const code = `skill.registerComponent("a", function () { return null; });`;
    reconcileFrontendModules(
      new Map<string, string>(),
      [{ name: "alpha", code }],
      registry,
    );
    expect(registry.resolve("a")).toBeDefined();
    const { unregistered } = reconcileFrontendModules(
      new Map([["alpha", code]]),
      [],
      registry,
    );
    expect(unregistered).toEqual(["alpha"]);
    expect(registry.resolve("a")).toBeUndefined();
  });

  it("re-evaluates a re-shipped module when its code changes", () => {
    const v1Code = `skill.registerComponent("v", function V1() { return React.createElement("div", null, "v1"); });`;
    reconcileFrontendModules(
      new Map<string, string>(),
      [{ name: "live", code: v1Code }],
      registry,
    );
    const v1 = registry.resolve("v");
    expect(v1).toBeDefined();
    const v2Code = `skill.registerComponent("v", function V2() { return React.createElement("div", null, "v2"); });`;
    const { loaded, skipped } = reconcileFrontendModules(
      new Map([["live", v1Code]]),
      [{ name: "live", code: v2Code }],
      registry,
    );
    expect(loaded.map((l) => l.name)).toEqual(["live"]);
    expect(skipped).toEqual([]);
    const v2 = registry.resolve("v");
    expect(v2).toBeDefined();
    expect(v2).not.toBe(v1);
  });

  it("skips byte-identical re-deliveries so duplicate ready events don't double-run side effects", () => {
    const code = `
      // Top-level side effect — simulates a module that injects a
      // <style> or arms a setInterval at load time.
      globalThis.__ext_runs = (globalThis.__ext_runs ?? 0) + 1;
      skill.registerComponent("s", function () { return null; });
    `;
    const g = globalThis as unknown as { __ext_runs?: number };
    g.__ext_runs = 0;
    const first = reconcileFrontendModules(
      new Map<string, string>(),
      [{ name: "stable", code }],
      registry,
    );
    expect(first.loaded.map((l) => l.name)).toEqual(["stable"]);
    expect(first.skipped).toEqual([]);
    expect(g.__ext_runs).toBe(1);

    const second = reconcileFrontendModules(
      new Map([["stable", code]]),
      [{ name: "stable", code }],
      registry,
    );
    expect(second.loaded).toEqual([]);
    expect(second.skipped).toEqual(["stable"]);
    // Critical: the side effect did NOT run a second time.
    expect(g.__ext_runs).toBe(1);
    // Component still resolves (it was never unregistered).
    expect(registry.resolve("s")).toBeDefined();
    delete g.__ext_runs;
  });
});
