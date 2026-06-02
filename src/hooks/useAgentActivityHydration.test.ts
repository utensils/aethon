// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEmptyTab } from "../types/tab";
import {
  AGENT_ACTIVITY_HYDRATION_RETRY_DELAYS_MS,
  hydrateAgentActivityState,
  useAgentActivityHydration,
} from "./useAgentActivityHydration";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

describe("hydrateAgentActivityState", () => {
  it("marks a restored active tab busy from live agent diagnostics", () => {
    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: false,
        status: "ready",
        tabs: [makeEmptyTab("tab-a", "A")],
      },
      [
        {
          key: "tab:tab-a",
          tab_id: "tab-a",
          alive: true,
          prompt_in_flight: true,
        },
      ],
    );

    expect((next.tabs as ReturnType<typeof makeEmptyTab>[])[0].waiting).toBe(
      true,
    );
    expect(next.waiting).toBe(true);
    expect(next.status).toBe("thinking…");
  });

  it("repairs the active root mirror when the tab was already marked busy", () => {
    const busyTab = { ...makeEmptyTab("tab-a", "A"), waiting: true };
    const tabs = [busyTab];
    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: false,
        status: "ready",
        tabs,
      },
      [
        {
          key: "tab:tab-a",
          tab_id: "tab-a",
          alive: true,
          prompt_in_flight: true,
        },
      ],
    );

    expect(next.waiting).toBe(true);
    expect(next.status).toBe("thinking…");
    expect(next.tabs).toBe(tabs);
  });

  it("maps the global worker to the default tab", () => {
    const next = hydrateAgentActivityState(
      {
        activeTabId: "default",
        waiting: false,
        status: "ready",
        tabs: [makeEmptyTab("default", "Default")],
      },
      [
        {
          key: "__global__",
          tab_id: null,
          alive: true,
          prompt_in_flight: true,
        },
      ],
    );

    expect((next.tabs as ReturnType<typeof makeEmptyTab>[])[0].waiting).toBe(
      true,
    );
    expect(next.waiting).toBe(true);
  });

  it("does not create tabs from orphan diagnostics", () => {
    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: false,
        tabs: [makeEmptyTab("tab-a", "A")],
      },
      [
        {
          key: "tab:missing",
          tab_id: "missing",
          alive: true,
          prompt_in_flight: true,
        },
      ],
    );

    expect((next.tabs as ReturnType<typeof makeEmptyTab>[]).map((t) => t.id))
      .toEqual(["tab-a"]);
    expect(next.waiting).toBe(false);
  });

  it("clears stale restored waiting state when diagnostics show no live prompt", () => {
    const waitingTab = { ...makeEmptyTab("tab-a", "A"), waiting: true };
    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: true,
        status: "thinking…",
        tabs: [waitingTab],
      },
      [
        {
          key: "tab:tab-a",
          tab_id: "tab-a",
          alive: true,
          prompt_in_flight: false,
        },
      ],
    );

    expect((next.tabs as ReturnType<typeof makeEmptyTab>[])[0].waiting).toBe(
      false,
    );
    expect(next.waiting).toBe(false);
    expect(next.status).toBe("ready");
  });

  it("clears stale restored waiting state when there are no live diagnostics", () => {
    const waitingTab = { ...makeEmptyTab("tab-a", "A"), waiting: true };
    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: true,
        status: "thinking…",
        tabs: [waitingTab],
      },
      [],
    );

    expect((next.tabs as ReturnType<typeof makeEmptyTab>[])[0].waiting).toBe(
      false,
    );
    expect(next.waiting).toBe(false);
    expect(next.status).toBe("ready");
  });

  it("retries diagnostics hydration so hot reload races recover stop affordance", async () => {
    vi.useFakeTimers();
    const tab = makeEmptyTab("tab-a", "A");
    let state: Record<string, unknown> = {
      activeTabId: "tab-a",
      waiting: false,
      status: "ready",
      tabs: [tab],
    };
    const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (
      arg,
    ) => {
      state = typeof arg === "function" ? arg(state) : arg;
    };
    invoke
      .mockResolvedValueOnce([
        {
          key: "tab:tab-a",
          tab_id: "tab-a",
          alive: true,
          prompt_in_flight: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "tab:tab-a",
          tab_id: "tab-a",
          alive: true,
          prompt_in_flight: true,
        },
      ]);

    renderHook(() => useAgentActivityHydration(setState));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(state).toMatchObject({ waiting: false, status: "ready" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        AGENT_ACTIVITY_HYDRATION_RETRY_DELAYS_MS[1],
      );
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ waiting: true, status: "thinking…" });
    expect(
      ((state.tabs as ReturnType<typeof makeEmptyTab>[])[0]).waiting,
    ).toBe(true);
  });
});
