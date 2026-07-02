// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileDeviceLanding } from "./layout";
import type { A2UIComponent } from "../../types/a2ui";

afterEach(() => cleanup());

function mobileLanding(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "mobile-device-landing",
    type: "mobile-device-landing",
    props,
  };
}

describe("MobileDeviceLanding", () => {
  it("renders useful read-only details for a selected phone", () => {
    const onEvent = vi.fn();
    render(
      <MobileDeviceLanding
        component={mobileLanding({ landing: { $ref: "/landing" } })}
        state={{
          landing: {
            kind: "mobile-device",
            deviceId: "device:dev-iphone",
            label: "James's iPhone",
            platform: "ios",
            connected: true,
            paired: true,
            createdAt: Date.parse("2026-07-01T17:30:00Z"),
            lastSeenAt: Date.parse("2026-07-02T05:45:00Z"),
          },
        }}
        onEvent={onEvent}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "James's iPhone" }),
    ).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("ios")).toBeTruthy();
    expect(screen.getByText("Client only")).toBeTruthy();
    expect(screen.getByText("Uses this desktop host")).toBeTruthy();
    expect(screen.getByText("dev-iphone")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpair device" }));
    expect(onEvent).toHaveBeenCalledWith(
      "unpair-mobile-device",
      {
        sectionId: "mobile-devices",
        itemId: "device:dev-iphone",
        deviceId: "device:dev-iphone",
        label: "James's iPhone",
      },
      "device:dev-iphone",
    );
  });

  it("does not render for non-device landing state", () => {
    const { container } = render(
      <MobileDeviceLanding
        component={mobileLanding({ landing: { $ref: "/landing" } })}
        state={{ landing: { kind: "workspace" } }}
        onEvent={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
