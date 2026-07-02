// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileHeader } from "./mobile-header";

vi.mock("../../gateway/useGatewayStatus", () => ({
  useGatewayStatus: () => "connected",
}));

afterEach(cleanup);

describe("MobileHeader", () => {
  it("shows only the gateway status before a project or session exists", () => {
    const { container } = render(
      <MobileHeader
        component={{ id: "mobile-header", type: "mobile-header" }}
        state={{}}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: "Gateway Online" })).toBeDefined();
    expect(container.querySelector(".app-header-pill")).toBeNull();
  });

  it("keeps agent chrome when a session exists but a non-agent surface is active", () => {
    const { container } = render(
      <MobileHeader
        component={{ id: "mobile-header", type: "mobile-header" }}
        state={{
          activeTabId: "overview",
          tabs: [{ id: "tab-1", kind: "agent" }],
          agentStatus: { label: "agent live", state: "live" },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(container.querySelector(".app-header-pill")).not.toBeNull();
  });

  it("restores agent/model chrome inside a project context", () => {
    const { container } = render(
      <MobileHeader
        component={{ id: "mobile-header", type: "mobile-header" }}
        state={{
          activeProjectId: "p1",
          agentStatus: { label: "agent live", state: "live" },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(container.querySelector(".app-header-pill")).not.toBeNull();
  });
});
