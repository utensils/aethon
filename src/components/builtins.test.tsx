import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { A2UIComponent } from "../types/a2ui";
import { DatePicker, Form, FormField, Icon } from "./builtins";

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
