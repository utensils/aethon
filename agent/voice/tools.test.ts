import { describe, expect, it } from "vitest";
import type { VoiceTurnContext } from "./protocol";
import {
  buildVoiceBrainTools,
  summarizeAsLabel,
  type DispatchedTask,
} from "./tools";

interface StartCall {
  projectPath: string;
  prompt: string;
  model: string;
  activate: boolean;
  label?: string;
}

function harness(options?: {
  context?: VoiceTurnContext;
  startResult?: { ok: boolean; error?: string; data?: unknown };
}) {
  const startCalls: StartCall[] = [];
  const dispatched: DispatchedTask[] = [];
  const tools = buildVoiceBrainTools({
    startTask: (input) => {
      startCalls.push(input);
      return Promise.resolve(
        options?.startResult ?? { ok: true, data: { tabId: "tab-42" } },
      );
    },
    getContext: () =>
      options?.context ?? {
        projectPath: "/repo/aethon",
        defaultModel: "anthropic/claude-x",
      },
    onDispatched: (task) => dispatched.push(task),
    listTasks: () => [...dispatched],
    countRunningTabs: () => 2,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { byName, startCalls, dispatched };
}

async function run(
  tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined,
  params: Record<string, unknown>,
): Promise<string> {
  if (!tool) throw new Error("tool missing");
  const result = (await tool.execute("call-1", params, undefined, undefined)) as {
    content: { type: string; text: string }[];
  };
  return result.content[0]?.text ?? "";
}

describe("dispatch_task", () => {
  it("launches a non-focused task with the context project + model", async () => {
    const h = harness();
    const text = await run(h.byName.get("dispatch_task"), {
      prompt: "Fix the flaky file-tree test",
      label: "fix flaky test",
    });
    expect(h.startCalls).toEqual([
      {
        projectPath: "/repo/aethon",
        prompt: "Fix the flaky file-tree test",
        model: "anthropic/claude-x",
        activate: false,
        label: "fix flaky test",
      },
    ]);
    expect(h.dispatched).toEqual([
      { tabId: "tab-42", label: "fix flaky test", status: "running" },
    ]);
    expect(text).toContain("tab-42");
  });

  it("derives a label from the prompt when none is given", async () => {
    const h = harness();
    await run(h.byName.get("dispatch_task"), {
      prompt: "Rename the config helper across the Rust shell",
    });
    expect(h.startCalls[0]?.label).toBe("Rename the config helper across the");
  });

  it("fails clearly without a project or model", async () => {
    const noProject = harness({ context: { defaultModel: "m" } });
    expect(
      await run(noProject.byName.get("dispatch_task"), { prompt: "x" }),
    ).toContain("no active project");
    expect(noProject.startCalls).toHaveLength(0);

    const noModel = harness({ context: { projectPath: "/p" } });
    expect(
      await run(noModel.byName.get("dispatch_task"), { prompt: "x" }),
    ).toContain("no work-agent model");
  });

  it("surfaces launcher errors without recording a dispatch", async () => {
    const h = harness({
      startResult: { ok: false, error: "unknown project path" },
    });
    const text = await run(h.byName.get("dispatch_task"), { prompt: "x" });
    expect(text).toContain("unknown project path");
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("check_status", () => {
  it("reports dispatched tasks and running tab count", async () => {
    const h = harness();
    await run(h.byName.get("dispatch_task"), {
      prompt: "task one",
      label: "task one",
    });
    const text = await run(h.byName.get("check_status"), {});
    expect(text).toContain('"task one" (tab tab-42): running');
    expect(text).toContain("currently working: 2");
  });

  it("says so when nothing was dispatched", async () => {
    const h = harness();
    const text = await run(h.byName.get("check_status"), {});
    expect(text).toContain("No tasks have been dispatched");
  });
});

describe("summarizeAsLabel", () => {
  it("truncates long prompts and survives empties", () => {
    expect(summarizeAsLabel("fix it")).toBe("fix it");
    expect(summarizeAsLabel("   ")).toBe("voice task");
    expect(
      summarizeAsLabel("a".repeat(60) + " word two three four five six"),
    ).toHaveLength(48);
  });
});
