import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { A2UIComponent } from "../../types/a2ui";
import { Container } from "./layout";

const noop = () => {};

function renderContainer(props: Record<string, unknown>): string {
  const component: A2UIComponent = { id: "c", type: "container", props };
  return renderToStaticMarkup(
    <Container
      component={component}
      state={{}}
      onEvent={noop}
      renderChildren={() => null}
    />,
  );
}

describe("Container gap/padding (falsy-zero regression)", () => {
  // Regression: an explicit `gap: 0` in the layout JSON must render as 0,
  // not fall through to the 8px default. The Source Control panel + file
  // tree rely on `gap: 0` to keep the tree flush at the band edge so it
  // aligns with the editor's top in the left column.
  it("honors an explicit gap: 0", () => {
    expect(renderContainer({ gap: 0 })).toContain("gap:0px");
  });

  it("honors an explicit padding: 0", () => {
    expect(renderContainer({ padding: 0 })).toContain("padding:0px");
  });

  it("defaults gap to 8px when omitted", () => {
    expect(renderContainer({})).toContain("gap:8px");
  });

  it("defaults padding to 0px when omitted", () => {
    expect(renderContainer({})).toContain("padding:0px");
  });

  it("passes through a positive gap", () => {
    expect(renderContainer({ gap: 16 })).toContain("gap:16px");
  });

  it("resolves a $ref gap of 0 to 0px", () => {
    const component: A2UIComponent = {
      id: "c",
      type: "container",
      props: { gap: { $ref: "/g" } },
    };
    const html = renderToStaticMarkup(
      <Container
        component={component}
        state={{ g: 0 }}
        onEvent={noop}
        renderChildren={() => null}
      />,
    );
    expect(html).toContain("gap:0px");
  });
});
