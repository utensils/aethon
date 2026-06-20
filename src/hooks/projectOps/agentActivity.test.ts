import { describe, it, expect } from "vitest";
import { makeEmptyTab, type Tab } from "../../types/tab";
import { attachAgentActivity, summarizeAgentTabs } from "./agentActivity";

function agentTab(id: string, projectId: string | null, cwd?: string): Tab {
  return { ...makeEmptyTab(id, id, projectId, "agent"), cwd };
}

describe("summarizeAgentTabs", () => {
  it("returns none for an empty scope", () => {
    expect(summarizeAgentTabs([], new Set())).toEqual({
      status: "none",
      activeCount: 0,
      runningCount: 0,
    });
  });

  it("returns idle-with-session when a session exists but nothing runs", () => {
    const tabs = [agentTab("a", "p", "/p")];
    expect(summarizeAgentTabs(tabs, new Set())).toEqual({
      status: "idle-with-session",
      activeCount: 1,
      runningCount: 0,
    });
  });

  it("returns running when at least one tab is in the running set", () => {
    const tabs = [agentTab("a", "p", "/p"), agentTab("b", "p", "/p")];
    expect(summarizeAgentTabs(tabs, new Set(["b"]))).toEqual({
      status: "running",
      activeCount: 2,
      runningCount: 1,
    });
  });

  it("returns needs-attention when a completed background turn is unread", () => {
    const tabs = [agentTab("a", "p", "/p")];
    expect(summarizeAgentTabs(tabs, new Set(), new Set(["a"]))).toEqual({
      status: "needs-attention",
      activeCount: 1,
      runningCount: 0,
    });
  });

  it("prioritizes running over needs-attention", () => {
    const tabs = [agentTab("a", "p", "/p"), agentTab("b", "p", "/p")];
    expect(summarizeAgentTabs(tabs, new Set(["b"]), new Set(["a"]))).toEqual({
      status: "running",
      activeCount: 2,
      runningCount: 1,
    });
  });

  it("ignores non-agent tabs", () => {
    const shell = { ...makeEmptyTab("s", "s", "p", "shell"), cwd: "/p" };
    expect(summarizeAgentTabs([shell], new Set(["s"]))).toEqual({
      status: "none",
      activeCount: 0,
      runningCount: 0,
    });
  });

  it("treats the running set as authoritative over a stale waiting flag", () => {
    // Background tab snapshot still carries waiting:true but is no longer in
    // the live running set — it must read as idle, not running.
    const stale: Tab = { ...agentTab("a", "p", "/p"), waiting: true };
    expect(summarizeAgentTabs([stale], new Set()).status).toBe(
      "idle-with-session",
    );
  });
});

describe("attachAgentActivity", () => {
  const project = (
    workspaces: { id: string; path: string; isMain?: boolean }[],
  ) => ({
    id: "proj",
    label: "proj",
    workspaces: workspaces.map((w) => ({
      id: w.id,
      label: w.id,
      branch: w.id,
      path: w.path,
      isMain: w.isMain ?? false,
    })),
  });

  it("scopes main-path tabs to both the project line and main workspace row", () => {
    const projects = [project([{ id: "wt-main", path: "/p", isMain: true }])];
    const tabs = [agentTab("a", "proj", "/p")];
    const [out] = attachAgentActivity(projects, tabs, new Set(["a"]));
    expect(out.agent.status).toBe("running");
    expect(out.agentRollup.status).toBe("running");
    expect(out.workspaces[0].agent?.status).toBe("running");
    expect(out.workspaces[0].agent?.runningCount).toBe(1);
  });

  it("scopes workspace-path tabs to that workspace row", () => {
    const projects = [
      project([
        { id: "wt-main", path: "/p", isMain: true },
        { id: "wt-feat", path: "/p/.wt/feat" },
      ]),
    ];
    const tabs = [agentTab("w", "proj", "/p/.wt/feat")];
    const [out] = attachAgentActivity(projects, tabs, new Set());
    // Not main scope — the project line stays empty.
    expect(out.agent.status).toBe("none");
    const feat = out.workspaces.find((w) => w.id === "wt-feat");
    expect(feat?.agent?.status).toBe("idle-with-session");
    // Rollup sees the workspace session even though main is empty.
    expect(out.agentRollup.status).toBe("idle-with-session");
  });

  it("rolls up running workspace activity for a collapsed project", () => {
    const projects = [
      project([
        { id: "wt-main", path: "/p", isMain: true },
        { id: "wt-feat", path: "/p/.wt/feat" },
      ]),
    ];
    const tabs = [
      agentTab("m", "proj", "/p"),
      agentTab("w", "proj", "/p/.wt/feat"),
    ];
    const [out] = attachAgentActivity(projects, tabs, new Set(["w"]));
    expect(out.agent.status).toBe("idle-with-session"); // only main, not running
    expect(out.agentRollup.status).toBe("running"); // workspace turn in flight
    expect(out.agentRollup.activeCount).toBe(2);
    expect(out.agentRollup.runningCount).toBe(1);
  });

  it("rolls up completed workspace activity that needs attention", () => {
    const projects = [
      project([
        { id: "wt-main", path: "/p", isMain: true },
        { id: "wt-feat", path: "/p/.wt/feat" },
      ]),
    ];
    const tabs = [agentTab("w", "proj", "/p/.wt/feat")];
    const [out] = attachAgentActivity(
      projects,
      tabs,
      new Set(),
      new Set(["w"]),
    );
    const feat = out.workspaces.find((w) => w.id === "wt-feat");
    expect(feat?.agent?.status).toBe("needs-attention");
    expect(out.agentRollup.status).toBe("needs-attention");
  });

  it("does not leak tabs across sibling projects", () => {
    const projects = [
      {
        id: "p1",
        label: "p1",
        workspaces: [{ id: "m1", path: "/p1", isMain: true }],
      },
      {
        id: "p2",
        label: "p2",
        workspaces: [{ id: "m2", path: "/p2", isMain: true }],
      },
    ];
    const tabs = [agentTab("a", "p1", "/p1")];
    const out = attachAgentActivity(projects, tabs, new Set(["a"]));
    expect(out[0].agent.status).toBe("running");
    expect(out[1].agent.status).toBe("none");
  });
});
