// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Layout } from "./layout";
import type { A2UIComponent } from "../../types/a2ui";

afterEach(() => cleanup());

function renderLayout(children: A2UIComponent[]) {
  return render(
    <Layout
      component={{
        id: "root",
        type: "layout",
        props: {
          columns: "0px minmax(0,1fr) 0px",
          rows: "38px 38px minmax(0,1fr) 0px auto auto",
          areas: [
            "sidebar header files-sidebar",
            "sidebar tabs files-sidebar",
            "sidebar canvas files-sidebar",
            "sidebar terminal files-sidebar",
            "sidebar composer files-sidebar",
            "status status status",
          ],
        },
        children,
      }}
      state={{ layout: { sidebarVisible: false }, terminal: { open: false } }}
      onEvent={() => {}}
      renderChild={(child) => <div>{child.id}</div>}
    />,
  );
}

describe("Layout panel motion affordances", () => {
  it("keeps chrome panels mounted while their grid tracks animate closed", () => {
    const { container } = renderLayout([
      {
        id: "sidebar",
        type: "container",
        props: { area: "sidebar", visible: false },
      },
      {
        id: "terminal",
        type: "terminal-panel",
        props: { area: "terminal", visible: false },
      },
      {
        id: "canvas",
        type: "container",
        props: { area: "canvas", visible: false },
      },
    ]);

    const cells = container.querySelectorAll<HTMLElement>(".a2ui-layout-cell");
    expect(cells[0]?.style.display).toBe("flex");
    expect(cells[0]?.dataset.visible).toBe("false");
    expect(cells[1]?.style.display).toBe("flex");
    expect(cells[1]?.dataset.visible).toBe("false");
    expect(cells[2]?.style.display).toBe("none");
  });

  it("leaves grid transition ownership to CSS", () => {
    const { container } = renderLayout([]);
    const root = container.querySelector<HTMLElement>(".a2ui-layout");
    expect(root?.style.transition).toBe("");
  });
});
