// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import A2UIRenderer from "./A2UIRenderer";
import { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import { ExtensionRegistryProvider } from "../extensions/ExtensionRegistryProvider";
import type { A2UIPayload } from "../types/a2ui";

function renderObserver(payload: A2UIPayload, state: Record<string, unknown>) {
  return render(
    <ExtensionRegistryProvider registry={new ExtensionRegistry()}>
      <A2UIRenderer payload={payload} state={state} onEvent={() => true} />
    </ExtensionRegistryProvider>,
  );
}

describe("A2UIRenderer observer overlay", () => {
  it("keeps external sibling updates live after a nested optimistic write", () => {
    const payload: A2UIPayload = {
      components: [
        {
          id: "card-local-input",
          type: "text-input",
          props: {
            value: { $ref: "/foo/bar" },
            placeholder: "bar",
          },
        },
        {
          id: "extension-sibling-value",
          type: "text",
          props: {
            content: { $ref: "/foo/baz" },
          },
        },
      ],
    };

    const { rerender } = renderObserver(payload, {
      foo: { bar: "local before", baz: "external before" },
    });

    fireEvent.change(screen.getByPlaceholderText("bar"), {
      target: { value: "local after" },
    });

    expect(screen.getByPlaceholderText("bar")).toMatchObject({
      value: "local after",
    });
    expect(screen.getByText("external before")).toBeTruthy();

    rerender(
      <ExtensionRegistryProvider registry={new ExtensionRegistry()}>
        <A2UIRenderer
          payload={payload}
          state={{ foo: { bar: "external bar", baz: "external after" } }}
          onEvent={() => true}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByPlaceholderText("bar")).toMatchObject({
      value: "local after",
    });
    expect(screen.getByText("external after")).toBeTruthy();
    expect(screen.queryByText("external before")).toBeNull();
  });

  it("keeps whole-object optimistic replacements from deep-merging external siblings", () => {
    const payload: A2UIPayload = {
      components: [
        {
          id: "replace-object",
          type: "button",
          props: {
            label: "Replace",
            event: "change",
            value: { $ref: "/foo" },
            data: { value: { bar: "local object" } },
          },
        },
        {
          id: "object-bar",
          type: "text",
          props: { content: { $ref: "/foo/bar" } },
        },
        {
          id: "object-baz",
          type: "text",
          props: { content: { $ref: "/foo/baz" } },
        },
      ],
    };

    renderObserver(payload, {
      foo: { bar: "external bar", baz: "external baz" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(screen.getByText("local object")).toBeTruthy();
    expect(screen.queryByText("external baz")).toBeNull();
  });
});
