/**
 * Smoke test: every M9 dashboard composite is registered on
 * `defaultLayoutExtension` AND its `type` can be swapped by a subsequent
 * extension registration. Proves the "everything is overrideable" contract.
 */
import { describe, expect, it } from "vitest";
import { defaultLayoutExtension } from "..";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import type { A2UIExtension } from "../../types";

describe("dashboard composite registration", () => {
  it("registers all five M9 chrome composites by stable type string", () => {
    const types = Object.keys(defaultLayoutExtension.components ?? {});
    for (const t of [
      "projects-dashboard",
      "project-dashboard",
      "task-launcher",
      "project-card",
      "gh-stats-strip",
    ]) {
      expect(types).toContain(t);
    }
  });

  it("a later extension can override project-dashboard by type", () => {
    const registry = new ExtensionRegistry();
    registry.register(defaultLayoutExtension);
    const before = registry.resolve("project-dashboard");
    expect(before).toBeDefined();

    const fake = () => null;
    const overrideExtension: A2UIExtension = {
      name: "test-override",
      components: { "project-dashboard": fake as never },
    };
    registry.register(overrideExtension);

    const after = registry.resolve("project-dashboard");
    expect(after).toBe(fake);
    expect(after).not.toBe(before);
  });

  it("override applies to every dashboard composite", () => {
    const registry = new ExtensionRegistry();
    registry.register(defaultLayoutExtension);
    const fake = () => null;
    registry.register({
      name: "swap-all",
      components: {
        "projects-dashboard": fake as never,
        "project-dashboard": fake as never,
        "task-launcher": fake as never,
        "project-card": fake as never,
        "gh-stats-strip": fake as never,
      },
    });
    expect(registry.resolve("projects-dashboard")).toBe(fake);
    expect(registry.resolve("project-dashboard")).toBe(fake);
    expect(registry.resolve("task-launcher")).toBe(fake);
    expect(registry.resolve("project-card")).toBe(fake);
    expect(registry.resolve("gh-stats-strip")).toBe(fake);
  });

  it("unregistering an override removes the type entirely (last-write-wins shape)", () => {
    // ExtensionRegistry's `unregister` deletes the type when its current
    // value matches the extension being removed. Documenting the actual
    // shape here: re-register the default-layout extension (or any extension
    // providing the type) to restore. This matches how the bridge
    // hot-reloads extensions on file changes.
    const registry = new ExtensionRegistry();
    registry.register(defaultLayoutExtension);
    const original = registry.resolve("task-launcher");
    const fake = () => null;
    registry.register({
      name: "tmp",
      components: { "task-launcher": fake as never },
    });
    expect(registry.resolve("task-launcher")).toBe(fake);
    registry.unregister("tmp");
    expect(registry.resolve("task-launcher")).toBeUndefined();
    // Re-register the default-layout extension to restore the built-in.
    registry.register(defaultLayoutExtension);
    expect(registry.resolve("task-launcher")).toBe(original);
  });
});
