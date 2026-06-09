import { describe, expect, it, vi } from "vitest";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { closeAllWorkspaceSessions } from "./closeWorkspaceSessions";
import { makeEmptyTab, NO_PROJECT_KEY, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import type { TabBucket } from "../projectOps/types";

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

function shellTab(id: string, projectId: string | null): Tab {
  return {
    ...makeEmptyTab(id, id, projectId, "shell"),
    shell: {
      cwd: "/tmp",
      command: "",
      args: [],
      shareMode: "private",
      shellState: "running",
    },
  };
}

function buildHarness(initial: Record<string, unknown>) {
  let state = initial;
  const stateRef = ref<Record<string, unknown>>(state);
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (
    update,
  ) => {
    state = typeof update === "function" ? update(state) : update;
    stateRef.current = state;
  };
  const tabBucketsRef = ref(new Map<string, TabBucket>());
  const closeTab = vi.fn((tabId: string) => {
    setState((prev) => ({
      ...prev,
      tabs: ((prev.tabs as Tab[] | undefined) ?? []).filter(
        (tab) => tab.id !== tabId,
      ),
    }));
  });
  const projectsRef = ref<ProjectsState>({
    activeId: null,
    activeWorkspaceId: null,
    activeHostId: "local:test",
    projects: [],
    workspacesByProject: {},
  });
  return {
    stateRef,
    setState,
    tabBucketsRef,
    closeTab,
    projectsRef,
    getState: () => state,
  };
}

describe("closeAllWorkspaceSessions", () => {
  it("keeps host shell tabs but clears stale host agent sessions from buckets", () => {
    const hostAgent = makeEmptyTab("host-agent", "Host Agent", null, "agent");
    const hostShell = shellTab("host-shell", null);
    const visibleAgent = makeEmptyTab(
      "visible-agent",
      "Visible Agent",
      null,
      "agent",
    );
    const visibleShell = shellTab("visible-shell", null);
    const h = buildHarness({
      tabs: [visibleAgent, visibleShell],
      closedSessionIds: ["already-closed"],
      persistedTabBuckets: {
        [NO_PROJECT_KEY]: {
          tabs: [hostAgent, hostShell],
          activeTabId: "host-agent",
        },
        "project-1": {
          tabs: [makeEmptyTab("project-agent", "Project Agent", "project-1")],
          activeTabId: "project-agent",
        },
      },
    });
    h.tabBucketsRef.current.set(NO_PROJECT_KEY, {
      tabs: [hostAgent, hostShell],
      activeTabId: "host-agent",
    });

    closeAllWorkspaceSessions(h);

    expect(h.closeTab).toHaveBeenCalledWith("visible-agent");
    expect((h.getState().tabs as Tab[]).map((tab) => tab.id)).toEqual([
      "visible-shell",
    ]);
    expect(h.tabBucketsRef.current.get(NO_PROJECT_KEY)).toEqual({
      tabs: [hostShell],
      activeTabId: undefined,
    });
    expect(
      (
        h.getState().persistedTabBuckets as Record<string, TabBucket>
      )[NO_PROJECT_KEY],
    ).toEqual({
      tabs: [hostShell],
      activeTabId: undefined,
    });
    expect(
      (
        h.getState().persistedTabBuckets as Record<string, TabBucket>
      )["project-1"]?.tabs.map((tab) => tab.id),
    ).toEqual(["project-agent"]);
    expect(h.getState().closedSessionIds).toEqual([
      "already-closed",
      "visible-agent",
      "host-agent",
    ]);
  });
});
