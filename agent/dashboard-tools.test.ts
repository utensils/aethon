// Pi-tool wrapper tests for `buildDashboardTools()`. Mirrors the
// shell-tools tests: each tool is a thin shim that calls the
// `globalThis.aethon.tasks` / `aethon.dashboard.*` API and adapts the
// result into the AgentToolResult the model sees.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboardTools } from "./dashboard-tools";

interface FakeTasks {
  start: ReturnType<typeof vi.fn>;
}
interface FakeDashboard {
  getRepoOverview: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

let fakeTasks: FakeTasks;
let fakeDashboard: FakeDashboard;
let originalAethon: unknown;

beforeEach(() => {
  fakeTasks = { start: vi.fn() };
  fakeDashboard = { getRepoOverview: vi.fn(), refresh: vi.fn() };
  originalAethon = (globalThis as { aethon?: unknown }).aethon;
  (globalThis as {
    aethon?: { tasks: FakeTasks; dashboard: FakeDashboard };
  }).aethon = { tasks: fakeTasks, dashboard: fakeDashboard };
});

afterEach(() => {
  (globalThis as { aethon?: unknown }).aethon = originalAethon;
});

function getTool(name: string) {
  const tools = buildDashboardTools();
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`tool ${name} not in catalogue`);
  return t;
}

describe("buildDashboardTools()", () => {
  it("registers startTask, getRepoOverview, refreshDashboard, listOpenIssues, getOpenIssue", () => {
    const tools = buildDashboardTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "getOpenIssue",
      "getRepoOverview",
      "listOpenIssues",
      "refreshDashboard",
      "startTask",
    ]);
  });
});

describe("startTask tool", () => {
  it("forwards prompt + worktree options to aethon.tasks.start", async () => {
    fakeTasks.start.mockResolvedValue({ ok: true, data: { projectId: "p1" } });
    const tool = getTool("startTask");
    await tool.execute("c1", {
      projectPath: "/p",
      prompt: "fix it",
      newWorktree: true,
      branch: "fix",
      baseBranch: "main",
    });
    expect(fakeTasks.start).toHaveBeenCalledWith({
      projectPath: "/p",
      prompt: "fix it",
      newWorktree: true,
      branch: "fix",
      baseBranch: "main",
    });
  });

  it("throws on ok=false so pi marks the tool result as an error", async () => {
    fakeTasks.start.mockResolvedValue({ ok: false, error: "no project" });
    const tool = getTool("startTask");
    await expect(
      tool.execute("c1", { projectPath: "/p", prompt: "hi" }),
    ).rejects.toThrow("no project");
  });
});

describe("getRepoOverview tool", () => {
  it("returns the overview as both text + details", async () => {
    const overview = {
      ghAvailable: true,
      repo: "owner/repo",
      stargazerCount: 9,
      openPrsCount: 1,
    };
    fakeDashboard.getRepoOverview.mockResolvedValue({
      ok: true,
      data: overview,
    });
    const tool = getTool("getRepoOverview");
    const r = await tool.execute("c2", { projectPath: "/p" });
    expect(fakeDashboard.getRepoOverview).toHaveBeenCalledWith({
      projectPath: "/p",
    });
    expect(r.details).toEqual(overview);
    expect(r.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify(overview, null, 2),
    });
  });
});

describe("refreshDashboard tool", () => {
  it("forwards projectPath when provided", async () => {
    fakeDashboard.refresh.mockResolvedValue({ ok: true });
    const tool = getTool("refreshDashboard");
    await tool.execute("c3", { projectPath: "/p" });
    expect(fakeDashboard.refresh).toHaveBeenCalledWith({ projectPath: "/p" });
  });

  it("calls refresh with no path when projectPath omitted", async () => {
    fakeDashboard.refresh.mockResolvedValue({ ok: true });
    const tool = getTool("refreshDashboard");
    await tool.execute("c4", {});
    expect(fakeDashboard.refresh).toHaveBeenCalledWith({});
  });
});
