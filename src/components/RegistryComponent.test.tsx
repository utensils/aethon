// Regression tests for the RegistryComponent helper that mounts app-root
// overlays through SkillRegistry. The previous code direct-imported the
// overlays in App.tsx, silently bypassing `aethon.registerComponent`
// overrides — the cases below catch that recurrence.
//
// Vitest runs in node (no jsdom), so we use react-dom/server and verify
// the helper's resolution + registry override semantics through the
// rendered markup. Live-event tests live in jsdom-backed harnesses.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RegistryComponent } from "./A2UIRenderer";
import { SkillRegistry } from "../skills/SkillRegistry";
import { SkillRegistryProvider } from "../skills/registry";
import type { BuiltinComponentProps } from "./A2UIRenderer";

const noop = () => {};

function CustomPalette({ component }: BuiltinComponentProps) {
  return <div data-testid="custom-palette" data-id={component.id}>OVERRIDE</div>;
}

describe("RegistryComponent", () => {
  it("renders nothing when the type is not registered", () => {
    const registry = new SkillRegistry();
    const html = renderToStaticMarkup(
      <SkillRegistryProvider registry={registry}>
        <RegistryComponent type="command-palette" state={{}} onEvent={noop} />
      </SkillRegistryProvider>,
    );
    expect(html).toBe("");
  });

  it("resolves a registered component type via the skill registry", () => {
    const registry = new SkillRegistry();
    registry.register({
      name: "test-skill",
      components: { "command-palette": CustomPalette },
    });
    const html = renderToStaticMarkup(
      <SkillRegistryProvider registry={registry}>
        <RegistryComponent type="command-palette" state={{}} onEvent={noop} />
      </SkillRegistryProvider>,
    );
    expect(html).toContain('data-testid="custom-palette"');
    expect(html).toContain('data-id="command-palette"');
    expect(html).toContain("OVERRIDE");
  });

  it("a later registration replaces the earlier one (override surface)", () => {
    const registry = new SkillRegistry();
    function Base({ component }: BuiltinComponentProps) {
      return <div data-id={component.id}>BASE</div>;
    }
    registry.register({
      name: "default",
      components: { "command-palette": Base },
    });
    registry.register({
      name: "user-skin",
      components: { "command-palette": CustomPalette },
    });
    const html = renderToStaticMarkup(
      <SkillRegistryProvider registry={registry}>
        <RegistryComponent type="command-palette" state={{}} onEvent={noop} />
      </SkillRegistryProvider>,
    );
    expect(html).toContain("OVERRIDE");
    expect(html).not.toContain("BASE");
  });

  it("forwards the parent state record verbatim", () => {
    const registry = new SkillRegistry();
    function Inspect({ state }: BuiltinComponentProps) {
      return <div>{Object.keys(state).join(",")}</div>;
    }
    registry.register({
      name: "t",
      components: { "search-panel": Inspect },
    });
    const html = renderToStaticMarkup(
      <SkillRegistryProvider registry={registry}>
        <RegistryComponent
          type="search-panel"
          state={{ a: 1, b: "x" }}
          onEvent={noop}
        />
      </SkillRegistryProvider>,
    );
    expect(html).toContain("a,b");
  });

  it("renders A2UI primitives (e.g. text) when used with a primitive type", () => {
    // Mostly defensive — overlays don't collide with primitive names, but
    // RegistryComponent should still resolve primitives like A2UIRenderer
    // does so the helper is safe to use anywhere.
    const registry = new SkillRegistry();
    const html = renderToStaticMarkup(
      <SkillRegistryProvider registry={registry}>
        <RegistryComponent type="text" state={{}} onEvent={noop} />
      </SkillRegistryProvider>,
    );
    // The text primitive renders an empty span with no content prop, but
    // the wrapper element exists.
    expect(html.length).toBeGreaterThan(0);
  });
});
