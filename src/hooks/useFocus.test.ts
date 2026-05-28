import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { OVERVIEW_TAB_ID, makeEmptyTab } from "../types/tab";
import { useFocus, workstationLayout, workstationRows } from "./useFocus";

describe("workstationLayout", () => {
  it("returns canonical 3-column shape with both sidebars visible", () => {
    const result = workstationLayout(
      { columns: "220px minmax(0,1fr) 280px" },
      true,
      true,
    );
    expect(result.columns).toBe("220px minmax(0,1fr) 280px");
    expect(result.areas).toEqual([
      "sidebar header files-sidebar",
      "sidebar tabs files-sidebar",
      "sidebar canvas files-sidebar",
      "sidebar terminal files-sidebar",
      "sidebar composer files-sidebar",
      "status status status",
    ]);
  });

  it("drops the right column when files sidebar hidden", () => {
    const result = workstationLayout(
      { columns: "220px minmax(0,1fr) 280px" },
      true,
      false,
    );
    expect(result.columns).toBe("220px minmax(0,1fr) 0px");
    expect(result.areas).toEqual([
      "sidebar header files-sidebar",
      "sidebar tabs files-sidebar",
      "sidebar canvas files-sidebar",
      "sidebar terminal files-sidebar",
      "sidebar composer files-sidebar",
      "status status status",
    ]);
  });

  it("drops the left column when sidebar hidden", () => {
    const result = workstationLayout(
      { columns: "220px minmax(0,1fr) 280px" },
      false,
      true,
    );
    expect(result.columns).toBe("0px minmax(0,1fr) 280px");
    expect(result.areas).toEqual([
      "sidebar header files-sidebar",
      "sidebar tabs files-sidebar",
      "sidebar canvas files-sidebar",
      "sidebar terminal files-sidebar",
      "sidebar composer files-sidebar",
      "status status status",
    ]);
  });

  it("collapses to a single column when both hidden", () => {
    const result = workstationLayout(
      { columns: "220px minmax(0,1fr) 280px" },
      false,
      false,
    );
    expect(result.columns).toBe("0px minmax(0,1fr) 0px");
    expect(result.areas).toEqual([
      "sidebar header files-sidebar",
      "sidebar tabs files-sidebar",
      "sidebar canvas files-sidebar",
      "sidebar terminal files-sidebar",
      "sidebar composer files-sidebar",
      "status status status",
    ]);
  });

  it("preserves user-resized widths across a hide/show round-trip", () => {
    // Resized to 320px / 360px → toggle right column off → toggle on.
    const hidden = workstationLayout(
      { columns: "320px minmax(0,1fr) 360px" },
      true,
      false,
    );
    // Width memo on `lastRightWidth` carries 360px forward.
    expect(hidden.lastRightWidth).toBe("360px");
    const restored = workstationLayout(
      {
        columns: hidden.columns,
        lastLeftWidth: hidden.lastLeftWidth,
        lastRightWidth: hidden.lastRightWidth,
      },
      true,
      true,
    );
    expect(restored.columns).toBe("320px minmax(0,1fr) 360px");
  });

  it("preserves left width when both sidebars cycle off+on", () => {
    const r1 = workstationLayout(
      { columns: "300px minmax(0,1fr) 280px" },
      false,
      false,
    );
    const r2 = workstationLayout(
      { columns: r1.columns, lastLeftWidth: r1.lastLeftWidth, lastRightWidth: r1.lastRightWidth },
      true,
      true,
    );
    expect(r2.columns).toBe("300px minmax(0,1fr) 280px");
  });

  it("falls back to default widths when current columns missing or malformed", () => {
    expect(workstationLayout({}, true, true).columns).toBe(
      "220px minmax(0,1fr) 360px",
    );
    expect(
      workstationLayout({ columns: "garbage" }, true, true).columns,
    ).toBe("220px minmax(0,1fr) 360px");
  });

  it("animates hidden chrome tracks with 0px sentinels but preserves memos", () => {
    const hidden = workstationLayout(
      {
        columns: "0px minmax(0,1fr) 0px",
        lastLeftWidth: "330px",
        lastRightWidth: "410px",
      },
      true,
      true,
    );
    expect(hidden.columns).toBe("330px minmax(0,1fr) 410px");
  });
});

describe("workstationRows", () => {
  it("uses a fixed terminal track so console toggles can animate", () => {
    expect(workstationRows(false, 240)).toBe(
      "38px 38px minmax(0,1fr) 0px auto auto",
    );
    expect(workstationRows(true, 360)).toBe(
      "38px 38px minmax(0,1fr) 360px auto auto",
    );
  });

  it("clamps terminal track height", () => {
    expect(workstationRows(true, 10)).toBe(
      "38px 38px minmax(0,1fr) 120px auto auto",
    );
    expect(workstationRows(true, 900)).toBe(
      "38px 38px minmax(0,1fr) 720px auto auto",
    );
  });
});

describe("toggleTerminal auto-spawn", () => {
  function useFocusHarness(initial: Record<string, unknown>) {
    let current = initial;
    const ref = <T,>(v: T): MutableRefObject<T> => ({ current: v });
    const stateRef = ref<Record<string, unknown>>(initial);
    const setState = vi.fn((updater: unknown) => {
      if (typeof updater !== "function") return;
      const fn = updater as (
        prev: Record<string, unknown>,
      ) => Record<string, unknown>;
      current = fn(current);
      stateRef.current = current;
    });
    const newShellTabOnOverviewOpen = vi.fn();
    const actions = useFocus({ setState, stateRef, newShellTabOnOverviewOpen });
    return { actions, setState, newShellTabOnOverviewOpen, get: () => current };
  }

  it("auto-spawns a shell when opening the terminal on overview with no shells", () => {
    const { actions, newShellTabOnOverviewOpen, get } = useFocusHarness({
      activeTabId: OVERVIEW_TAB_ID,
      tabs: [],
      terminal: { open: false },
      layout: {},
    });
    actions.toggleTerminal();
    expect(newShellTabOnOverviewOpen).toHaveBeenCalledTimes(1);
    expect((get().terminal as { open: boolean }).open).toBe(true);
  });

  it("does NOT auto-spawn when the terminal is closing", () => {
    const { actions, newShellTabOnOverviewOpen } = useFocusHarness({
      activeTabId: OVERVIEW_TAB_ID,
      tabs: [],
      terminal: { open: true },
      layout: {},
    });
    actions.toggleTerminal();
    expect(newShellTabOnOverviewOpen).not.toHaveBeenCalled();
  });

  it("does NOT auto-spawn when a shell already exists", () => {
    const { actions, newShellTabOnOverviewOpen } = useFocusHarness({
      activeTabId: OVERVIEW_TAB_ID,
      tabs: [makeEmptyTab("sh-1", "Shell 1", null, "shell")],
      terminal: { open: false },
      layout: {},
    });
    actions.toggleTerminal();
    expect(newShellTabOnOverviewOpen).not.toHaveBeenCalled();
  });

  it("does NOT auto-spawn when an agent session owns the canvas", () => {
    const { actions, newShellTabOnOverviewOpen } = useFocusHarness({
      activeTabId: "agent-1",
      tabs: [makeEmptyTab("agent-1", "Tab 1")],
      terminal: { open: false },
      layout: {},
    });
    actions.toggleTerminal();
    expect(newShellTabOnOverviewOpen).not.toHaveBeenCalled();
  });
});
