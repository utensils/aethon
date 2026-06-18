// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import A2UIRenderer from "./A2UIRenderer";
import { ExtensionRegistry } from "../extensions/ExtensionRegistry";
import { ExtensionRegistryProvider } from "../extensions/ExtensionRegistryProvider";
import { clearTauriMocks, installTauriMocks } from "../test/tauriMocks";

describe("A2UIRenderer window event metadata", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("dispatches surfaceId, windowId, and tabId for native canvas windows", async () => {
    render(
      <ExtensionRegistryProvider registry={new ExtensionRegistry()}>
        <A2UIRenderer
          payload={{
            components: [
              {
                id: "go",
                type: "button",
                props: { label: "Go", data: { answer: 42 } },
              },
            ],
          }}
          state={{}}
          tabId="tab-1"
          surfaceId="canvas-window:Workpad"
          windowId="Workpad"
        />
      </ExtensionRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() =>
      expect(harness.invoke).toHaveBeenCalledWith(
        "dispatch_a2ui_event",
        expect.objectContaining({ tabId: "tab-1" }),
      ),
    );
    const [, args] = harness.invoke.mock.calls.find(
      ([command]) => command === "dispatch_a2ui_event",
    )!;
    const event = JSON.parse(args.event as string);
    expect(event).toMatchObject({
      componentId: "go",
      componentType: "button",
      eventType: "click",
      surfaceId: "canvas-window:Workpad",
      windowId: "Workpad",
      data: { answer: 42 },
    });
  });
});
