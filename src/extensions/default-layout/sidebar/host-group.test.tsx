// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostGroup, type HostGroupItem } from "./host-group";

afterEach(() => cleanup());

const localHost: HostGroupItem = {
  id: "local:abc",
  label: "halcyon",
  hint: "this mac",
  tooltip: "halcyon.local",
  active: true,
};

const remoteHost: HostGroupItem = {
  id: "remote:bender",
  label: "bender",
  hint: "bender.local",
  tooltip: "bender.local",
  active: false,
};

describe("HostGroup", () => {
  it("renders the host name and the this-mac badge for the local host", () => {
    render(
      <HostGroup
        host={localHost}
        expanded
        collapsible
        onToggleExpand={vi.fn()}
        onSelectHost={vi.fn()}
      >
        <div data-testid="projects">projects</div>
      </HostGroup>,
    );
    expect(screen.getByText("halcyon")).toBeTruthy();
    expect(screen.getByText("this mac")).toBeTruthy();
    // Body children render when expanded.
    expect(screen.getByTestId("projects")).toBeTruthy();
  });

  it("shows the remote hostname badge for a non-local host", () => {
    render(
      <HostGroup
        host={remoteHost}
        expanded={false}
        collapsible={false}
        onToggleExpand={vi.fn()}
        onSelectHost={vi.fn()}
      />,
    );
    expect(screen.getByText("bender")).toBeTruthy();
    expect(screen.getByText("bender.local")).toBeTruthy();
  });

  it("hides the body when collapsed", () => {
    render(
      <HostGroup
        host={localHost}
        expanded={false}
        collapsible
        onToggleExpand={vi.fn()}
        onSelectHost={vi.fn()}
      >
        <div data-testid="projects">projects</div>
      </HostGroup>,
    );
    expect(screen.queryByTestId("projects")).toBeNull();
  });

  it("toggles expansion via the chevron without selecting the host", () => {
    const onToggleExpand = vi.fn();
    const onSelectHost = vi.fn();
    render(
      <HostGroup
        host={localHost}
        expanded
        collapsible
        onToggleExpand={onToggleExpand}
        onSelectHost={onSelectHost}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /collapse host/i }));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    expect(onSelectHost).not.toHaveBeenCalled();
  });

  it("selects the host when the header is clicked", () => {
    const onSelectHost = vi.fn();
    render(
      <HostGroup
        host={localHost}
        expanded
        collapsible
        onToggleExpand={vi.fn()}
        onSelectHost={onSelectHost}
      />,
    );
    fireEvent.click(screen.getByText("halcyon"));
    expect(onSelectHost).toHaveBeenCalledTimes(1);
  });

  it("marks the host row as current when the host workspace is selected", () => {
    render(
      <HostGroup
        host={localHost}
        selected
        expanded
        collapsible
        onToggleExpand={vi.fn()}
        onSelectHost={vi.fn()}
      />,
    );

    const header = screen.getByText("halcyon").closest(".ae-host-group-header");
    expect(header?.classList.contains("ae-host-group-header--selected")).toBe(
      true,
    );
    expect(header?.getAttribute("aria-current")).toBe("page");
    expect(header?.closest(".ae-host-group")?.classList).toContain(
      "ae-host-group--selected",
    );
  });
});
