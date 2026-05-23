// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSessionRow } from "./session-row";

afterEach(() => cleanup());

describe("DashboardSessionRow", () => {
  it("restores the session when the row is clicked", () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    render(
      <ul>
        <DashboardSessionRow
          session={{
            id: "s1",
            label: "Refactor notes",
            lastModified: "1h ago",
          }}
          classPrefix="a2ui-projects-dashboard"
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </ul>,
    );

    fireEvent.click(screen.getByText("Refactor notes"));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("opens inline confirmation from the trash icon", () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    render(
      <ul>
        <DashboardSessionRow
          session={{ id: "s1", label: "Refactor notes" }}
          classPrefix="a2ui-projects-dashboard"
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </ul>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Refactor notes" }),
    );
    expect(
      screen.getByRole("button", { name: "Confirm delete Refactor notes" })
        .textContent,
    ).toBe("Confirm");
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("deletes without also restoring when inline confirmation is clicked", () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    render(
      <ul>
        <DashboardSessionRow
          session={{ id: "s1", label: "Refactor notes" }}
          classPrefix="a2ui-projects-dashboard"
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </ul>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Refactor notes" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm delete Refactor notes" }),
    );
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("clears inline confirmation on mouse leave", () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const { container } = render(
      <ul>
        <DashboardSessionRow
          session={{ id: "s1", label: "Refactor notes" }}
          classPrefix="a2ui-projects-dashboard"
          onRestore={onRestore}
          onDelete={onDelete}
        />
      </ul>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Refactor notes" }),
    );
    fireEvent.mouseLeave(container.querySelector("li")!);
    fireEvent.click(screen.getByText("Refactor notes"));

    expect(onDelete).not.toHaveBeenCalled();
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
