// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileProjects } from "./mobile-projects";

afterEach(cleanup);

describe("MobileProjects", () => {
  it("renders the active host as the top-level parent above projects", () => {
    const onEvent = vi.fn();
    render(
      <MobileProjects
        component={{ id: "projects", type: "mobile-projects" }}
        state={{
          activeHostId: "local:halcyon",
          sidebar: {
            hosts: [
              {
                id: "local:halcyon",
                label: "halcyon",
                hint: "this mac",
                active: true,
              },
            ],
            projects: [
              {
                id: "p1",
                label: "aethon",
                path: "/Users/jamesbrink/Projects/aethon",
              },
            ],
          },
        }}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByRole("button", { name: /halcyon/i })).toBeDefined();
    expect(screen.getByText("connected desktop")).toBeDefined();
    expect(screen.getByText("aethon")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /halcyon/i }));
    expect(onEvent).toHaveBeenCalledWith(
      "select",
      { sectionId: "hosts", itemId: "local:halcyon" },
      "local:halcyon",
    );
  });
});
