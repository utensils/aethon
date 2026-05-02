import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { A2UIComponent } from "../types/a2ui";
import { Button, DatePicker, Form, FormField, Icon } from "./builtins";

const noop = () => {};

describe("new A2UI primitives", () => {
  it("renders icon glyphs with accessible labels", () => {
    const component: A2UIComponent = {
      id: "status-icon",
      type: "icon",
      props: { name: "check", label: "Ready", size: 18 },
    };

    const html = renderToStaticMarkup(
      <Icon component={component} state={{}} onEvent={noop} />,
    );

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ready"');
    expect(html).toContain("✓");
  });

  it("renders date-picker as a named native date input", () => {
    const component: A2UIComponent = {
      id: "due",
      type: "date-picker",
      props: {
        value: { $ref: "/due" },
        name: "due",
        min: "2026-01-01",
        max: "2026-12-31",
        required: true,
      },
    };

    const html = renderToStaticMarkup(
      <DatePicker
        component={component}
        state={{ due: "2026-04-28" }}
        onEvent={noop}
      />,
    );

    expect(html).toContain('type="date"');
    expect(html).toContain('name="due"');
    expect(html).toContain('value="2026-04-28"');
    expect(html).toContain("required");
  });

  it("renders form-field chrome and form submit button", () => {
    const field: A2UIComponent = {
      id: "field",
      type: "form-field",
      props: {
        label: "Project",
        description: "Choose a working directory.",
        required: true,
      },
    };
    const form: A2UIComponent = {
      id: "form",
      type: "form",
      props: { submitLabel: "Apply" },
    };

    const fieldHtml = renderToStaticMarkup(
      <FormField
        component={field}
        state={{}}
        onEvent={noop}
        renderChildren={() => <input name="project" />}
      />,
    );
    const formHtml = renderToStaticMarkup(
      <Form
        component={form}
        state={{}}
        onEvent={noop}
        renderChildren={() => <input name="project" />}
      />,
    );

    expect(fieldHtml).toContain("Project");
    expect(fieldHtml).toContain("Choose a working directory.");
    expect(fieldHtml).toContain("*");
    expect(formHtml).toContain("<form");
    expect(formHtml).toContain('type="submit"');
    expect(formHtml).toContain("Apply");
  });
});

describe("Button event override", () => {
  // Codex pass-6 added this contract: a declarative override template
  // for `share-mode-badge` (or any host that listens for a non-`click`
  // event) needs a way to make a primitive button emit that event
  // directly. Without this, custom badge templates can never trigger
  // the `cycle-share-mode` adapter — the bridge intentionally has no
  // setShareMode, so they'd be display-only.
  //
  // Vitest runs in node (no jsdom), so we exercise the closure directly
  // by reaching into the React element tree we pass to Button. That
  // verifies handleClick wires the event/data props through correctly.

  function readClickHandler(
    onEvent: (eventType: string, data?: unknown) => void,
    component: A2UIComponent,
  ): () => void {
    // React.createElement(Button, ...).type is Button itself; calling it
    // synchronously returns the rendered React element (a <button>).
    // Read its onClick prop and invoke directly.
    const element = (
      Button({ component, state: {}, onEvent }) as unknown as {
        props: { onClick?: () => void };
      }
    );
    if (typeof element.props.onClick !== "function") {
      throw new Error("Button did not return an onClick handler");
    }
    return element.props.onClick;
  }

  it("emits 'click' by default", () => {
    const onEvent = vi.fn();
    const handler = readClickHandler(onEvent, {
      id: "b",
      type: "button",
      props: { label: "Cycle" },
    });
    handler();
    expect(onEvent).toHaveBeenCalledWith("click", {});
  });

  it("respects the `event` prop override (cycle-share-mode pattern)", () => {
    const onEvent = vi.fn();
    const handler = readClickHandler(onEvent, {
      id: "ext-cycle",
      type: "button",
      props: {
        label: "Toggle",
        event: "cycle-share-mode",
        data: { tabId: "t-1" },
      },
    });
    handler();
    expect(onEvent).toHaveBeenCalledWith("cycle-share-mode", { tabId: "t-1" });
  });

  it("ignores invalid event values and falls back to 'click'", () => {
    const onEvent = vi.fn();
    const handler = readClickHandler(onEvent, {
      id: "b",
      type: "button",
      props: { label: "X", event: "" },
    });
    handler();
    expect(onEvent).toHaveBeenCalledWith("click", {});
  });
});
