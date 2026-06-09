import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createShellOutputCoalescer } from "./shellStreams";
import { TERMINAL_REPLAY_MAX } from "../useTabs";
import type { Tab } from "../../types/tab";

function makeTab(buffer = ""): Tab {
  return {
    id: "shell-1",
    label: "shell",
    kind: "shell",
    terminalBuffer: buffer,
  } as unknown as Tab;
}

describe("createShellOutputCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("coalesces many chunks into one updateTab per flush window", () => {
    const calls: string[] = [];
    let tab = makeTab();
    const updateTab = (_id: string, mutator: (t: Tab) => Tab) => {
      tab = mutator(tab);
      calls.push(tab.terminalBuffer);
    };
    const c = createShellOutputCoalescer(updateTab, 100);

    for (let i = 0; i < 50; i++) c.push("shell-1", `chunk${i};`);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(100);

    expect(calls).toHaveLength(1);
    expect(tab.terminalBuffer).toContain("chunk0;");
    expect(tab.terminalBuffer).toContain("chunk49;");
  });

  test("flushTab applies pending output synchronously (shell exit path)", () => {
    let tab = makeTab("prior;");
    const c = createShellOutputCoalescer((_id, mutator) => {
      tab = mutator(tab);
    }, 100);

    c.push("shell-1", "final output");
    c.flushTab("shell-1");

    expect(tab.terminalBuffer).toBe("prior;final output");

    // The timer firing later must not double-apply.
    vi.advanceTimersByTime(200);
    expect(tab.terminalBuffer).toBe("prior;final output");
  });

  test("trims to TERMINAL_REPLAY_MAX at flush and in the pending buffer", () => {
    let tab = makeTab();
    const c = createShellOutputCoalescer((_id, mutator) => {
      tab = mutator(tab);
    }, 100);

    c.push("shell-1", "x".repeat(TERMINAL_REPLAY_MAX));
    c.push("shell-1", "tail-marker");
    c.flushAll();

    expect(tab.terminalBuffer.length).toBeLessThanOrEqual(TERMINAL_REPLAY_MAX);
    expect(tab.terminalBuffer.endsWith("tail-marker")).toBe(true);
  });

  test("tracks tabs independently", () => {
    const buffers = new Map<string, string>([
      ["a", ""],
      ["b", ""],
    ]);
    const c = createShellOutputCoalescer((id, mutator) => {
      const t = mutator(makeTabWithBuffer(buffers.get(id) ?? ""));
      buffers.set(id, t.terminalBuffer);
    }, 100);

    c.push("a", "alpha");
    c.push("b", "beta");
    c.flushAll();

    expect(buffers.get("a")).toBe("alpha");
    expect(buffers.get("b")).toBe("beta");
  });
});

function makeTabWithBuffer(buffer: string): Tab {
  return { id: "x", label: "x", kind: "shell", terminalBuffer: buffer } as unknown as Tab;
}
