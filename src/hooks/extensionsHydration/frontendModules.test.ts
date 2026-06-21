import { describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { ExtensionRegistry } from "../../extensions/ExtensionRegistry";
import { useHydrateFrontendModules } from "./frontendModules";

function makeSetState(state: Record<string, unknown>) {
  return vi.fn((update: SetStateAction<Record<string, unknown>>) => {
    Object.assign(
      state,
      typeof update === "function" ? update({ ...state }) : update,
    );
  }) as Dispatch<SetStateAction<Record<string, unknown>>>;
}

describe("useHydrateFrontendModules", () => {
  it("records loaded component types and frontend eval failures in state", () => {
    const state: Record<string, unknown> = {};
    const appendSystem = vi.fn();
    const registry = new ExtensionRegistry();
    const hydrate = useHydrateFrontendModules({
      setState: makeSetState(state),
      frontendModulesRef: { current: new Map() },
      registry,
      appendSystem,
    });

    hydrate([
      {
        name: "ok-ext",
        code: "extension.registerComponent('ok-widget', function OkWidget(){ return React.createElement('div'); });",
      },
      {
        name: "bad-ext",
        code: "throw new Error('frontend boom')",
      },
    ]);

    expect(state.extensionFrontendModules).toEqual([
      {
        name: "ok-ext",
        status: "loaded",
        componentTypes: ["ok-widget"],
      },
      {
        name: "bad-ext",
        status: "failed",
        componentTypes: [],
        error: "frontend boom",
      },
    ]);
    expect(registry.resolve("ok-widget")).toBeTypeOf("function");
    expect(appendSystem).toHaveBeenCalledWith(
      "extension frontend module bad-ext: frontend boom",
    );
  });

  it("removes status for unregistered modules", () => {
    const state: Record<string, unknown> = {};
    const registry = new ExtensionRegistry();
    const frontendModulesRef = { current: new Map<string, string>() };
    const hydrate = useHydrateFrontendModules({
      setState: makeSetState(state),
      frontendModulesRef,
      registry,
      appendSystem: vi.fn(),
    });

    hydrate([
      {
        name: "ok-ext",
        code: "extension.registerComponent('ok-widget', function OkWidget(){ return React.createElement('div'); });",
      },
    ]);
    hydrate([]);

    expect(state.extensionFrontendModules).toEqual([]);
    expect(registry.resolve("ok-widget")).toBeUndefined();
  });
});
