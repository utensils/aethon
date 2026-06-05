// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2UIComponent } from "../types/a2ui";
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

    expect(
      (next.tabs as ReturnType<typeof makeEmptyTab>[]).map((t) => t.id),
    ).toEqual(["tab-a"]);
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

  it("keeps another tab's running tool card when diagnostics only mention a different worker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const tabA = {
      ...makeEmptyTab("tab-a", "A"),
      waiting: true,
      messages: [
        {
          id: "tool-message",
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: "tool-1-call_1",
                type: "tool-card",
                props: {
                  title: "bash",
                  description: "sleep 60",
                  startedAt: 100_000,
                },
                children: [],
              },
            ],
          },
        },
      ],
    };
    const tabB = makeEmptyTab("tab-b", "B");

    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: true,
        status: "thinking…",
        agentRunningTabs: { "tab-a": true },
        tabs: [tabA, tabB],
      },
      [
        {
          key: "tab:tab-b",
          tab_id: "tab-b",
          alive: true,
          prompt_in_flight: true,
        },
      ],
    );

    expect(next.status).toBe("thinking…");
    const outTabA = (next.tabs as (typeof tabA)[])[0];
    expect(outTabA.waiting).toBe(true);
    const toolCard = outTabA.messages[0].a2ui?.components?.[0] as
      | A2UIComponent
      | undefined;
    expect(toolCard?.props?.endedAt).toBeUndefined();
    expect(toolCard?.props?.status).toBeUndefined();
  });

  it("marks stale running tool cards stopped when diagnostics only show unrelated idle workers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const waitingTab = {
      ...makeEmptyTab("tab-a", "A"),
      waiting: true,
      messages: [
        {
          id: "tool-message",
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: "tool-1-call_1",
                type: "tool-card",
                props: {
                  title: "bash",
                  description: "sleep 60",
                  startedAt: 100_000,
                },
                children: [],
              },
            ],
          },
        },
      ],
    };

    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: true,
        status: "thinking…",
        agentRunningTabs: { "tab-a": true },
        tabs: [waitingTab],
      },
      [
        {
          key: "__global__",
          tab_id: null,
          alive: true,
          prompt_in_flight: false,
        },
      ],
    );

    expect(next.status).toBe("ready");
    const toolCard = ((next.tabs as (typeof waitingTab)[])[0].messages[0].a2ui
      ?.components?.[0] ?? {}) as A2UIComponent;
    expect(toolCard.props).toMatchObject({
      status: "cancelled",
      endedAt: 123_456,
    });
  });

  it("marks stale running tool cards stopped when diagnostics show no live prompt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const waitingTab = {
      ...makeEmptyTab("tab-a", "A"),
      messages: [
        {
          id: "tool-message",
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: "restored-tool-call_1",
                type: "tool-card",
                props: {
                  title: "bash",
                  description: "curl https://example.test",
                  startedAt: 100_000,
                },
                children: [],
              },
            ],
          },
        },
      ],
    };

    const next = hydrateAgentActivityState(
      {
        activeTabId: "tab-a",
        waiting: false,
        status: "stopping…",
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

    expect(next.status).toBe("ready");
    const components = (next.tabs as (typeof waitingTab)[])[0].messages[0].a2ui
      ?.components as A2UIComponent[] | undefined;
    const toolCard = components?.[0];
    expect(toolCard).toBeDefined();
    if (!toolCard) {
      throw new Error("expected restored tool card to be preserved");
    }
    expect(toolCard?.props).toMatchObject({
      status: "cancelled",
      endedAt: 123_456,
    });
    expect(toolCard.children?.[0].props?.content).toContain(
      "No live prompt is running",
    );
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
    expect((state.tabs as ReturnType<typeof makeEmptyTab>[])[0].waiting).toBe(
      true,
    );
  });
});
