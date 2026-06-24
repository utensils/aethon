import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";
import { activateTabAnywhereNow } from "./useActivateTabAnywhere";

const agentTab = (id: string): Tab => ({
  id,
  kind: "agent",
  label: id,
  messages: [],
  draft: "",
  waiting: false,
  queueCount: 0,
  queuedMessages: [],
  canvas: null,
  model: "gpt",
  terminalBuffer: "",
  projectId: null,
});

function deps(seed: {
  tabs?: Tab[];
  buckets?: [string, TabBucket][];
  activeProjectId?: string | null;
}) {
  const calls: string[] = [];
  return {
    calls,
    stateRef: {
      current: {
        tabs: seed.tabs ?? [],
        activeProjectId: seed.activeProjectId ?? null,
      },
    },
    tabBucketsRef: { current: new Map(seed.buckets ?? []) },
    setActiveTab: vi.fn((tabId: string) => calls.push(`tab:${tabId}`)),
    setActiveProjectById: vi.fn((projectId: string) => {
      calls.push(`project:${projectId}`);
      return true;
    }),
    clearActiveProject: vi.fn(() => calls.push("project:null")),
    activateWorkspace: vi.fn((workspaceId: string | null) =>
      calls.push(`workspace:${workspaceId ?? "null"}`),
    ),
  };
}

describe("activateTabAnywhereNow", () => {
  it("selects already-visible tabs directly", () => {
    const ctx = deps({ tabs: [agentTab("tab-1")], activeProjectId: "p1" });

    activateTabAnywhereNow(ctx, "tab-1");

    expect(ctx.setActiveTab).toHaveBeenCalledWith("tab-1");
    expect(ctx.setActiveProjectById).not.toHaveBeenCalled();
    expect(ctx.activateWorkspace).not.toHaveBeenCalled();
    expect(ctx.calls).toEqual(["tab:tab-1"]);
  });

  it("switches project and workspace before selecting a bucketed tab", () => {
    const ctx = deps({
      activeProjectId: "old-project",
      buckets: [
        [
          "new-project::workspace::workspace-1",
          { tabs: [agentTab("hidden-tab")], activeTabId: "hidden-tab" },
        ],
      ],
    });

    activateTabAnywhereNow(ctx, "hidden-tab");

    expect(ctx.calls).toEqual([
      "project:new-project",
      "workspace:workspace-1",
      "tab:hidden-tab",
    ]);
  });

  it("clears the active project for no-project bucketed tabs", () => {
    const ctx = deps({
      activeProjectId: "project-1",
      buckets: [
        ["__no_project__", { tabs: [agentTab("loose-tab")], activeTabId: "loose-tab" }],
      ],
    });

    activateTabAnywhereNow(ctx, "loose-tab");

    expect(ctx.calls).toEqual([
      "project:null",
      "workspace:null",
      "tab:loose-tab",
    ]);
  });

  it("best-effort selects unknown tabs without switching project/workspace", () => {
    const ctx = deps({ activeProjectId: "project-1" });

    activateTabAnywhereNow(ctx, "missing-tab");

    expect(ctx.calls).toEqual(["tab:missing-tab"]);
  });
});
