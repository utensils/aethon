// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileNav } from "./mobile-nav";

afterEach(cleanup);

describe("MobileNav", () => {
  it("shows only orientation screens before a project or session exists", () => {
    render(
      <MobileNav
        component={{ id: "nav", type: "mobile-nav" }}
        state={{ mobileNav: { active: "projects" } }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /projects/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /sessions/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /chat/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /files/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /git/i })).toBeNull();
  });

  it("shows chat for an existing active agent session without project tools", () => {
    render(
      <MobileNav
        component={{ id: "nav", type: "mobile-nav" }}
        state={{
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", kind: "agent" }],
          mobileNav: { active: "chat" },
        }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /chat/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /files/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /git/i })).toBeNull();
  });

  it("shows project-bound work surfaces when a project is active", () => {
    render(
      <MobileNav
        component={{ id: "nav", type: "mobile-nav" }}
        state={{ activeProjectId: "p1", mobileNav: { active: "files" } }}
        onEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /projects/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /sessions/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /chat/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /files/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /terminal/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /git/i })).toBeDefined();
  });

  it("highlights Projects while the project detail screen is visible", () => {
    render(
      <MobileNav
        component={{ id: "nav", type: "mobile-nav" }}
        state={{ activeProjectId: "p1", mobileNav: { active: "projects" } }}
        onEvent={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /projects/i }).className,
    ).toContain("ae-mobile-nav-item--active");
  });
});
