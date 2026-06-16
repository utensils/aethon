// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createShellOutputCoalescer,
  subscribeShellStreams,
} from "./shellStreams";
import { TERMINAL_REPLAY_MAX } from "../useTabs";
import type { Tab } from "../../types/tab";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

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
  return {
    id: "x",
    label: "x",
    kind: "shell",
    terminalBuffer: buffer,
  } as unknown as Tab;
}

describe("subscribeShellStreams", () => {
  let harness: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    harness = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  test("respawns a live shell tab when its PTY exits", async () => {
    let tab: Tab = {
      ...makeTab(),
      shell: {
        cwd: "/repo/app",
        command: "",
        args: [],
        shareMode: "read",
        shellState: "running",
      },
    };
    let state: Record<string, unknown> = { tabs: [tab] };
    const stateRef = { current: state };
    const updateTab = vi.fn((tabId: string, mutator: (t: Tab) => Tab) => {
      expect(tabId).toBe("shell-1");
      tab = mutator(tab);
      state = { tabs: [tab] };
      stateRef.current = state;
    });
    const appendSystem = vi.fn();

    subscribeShellStreams({
      updateTab,
      stateRef,
      appendSystem,
      shellInheritEnvRef: { current: false },
    });
    await Promise.resolve();

    expect(harness.fireEvent("shell-exit", { tabId: "shell-1", code: 0 })).toBe(
      1,
    );
    expect(tab.shell?.shellState).toBe("starting");

    await vi.waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("shell_open", {
        args: {
          tabId: "shell-1",
          cwd: "/repo/app",
          shareMode: "read",
          inheritEnv: false,
        },
      });
    });

    expect(tab.shell?.shellState).toBe("running");
    expect(tab.shell?.exitCode).toBeUndefined();
    expect(appendSystem).not.toHaveBeenCalled();
  });

  test("marks the shell as failed when respawn cannot reopen it", async () => {
    let tab: Tab = {
      ...makeTab(),
      shell: {
        cwd: "/repo/app",
        command: "",
        args: [],
        shareMode: "private",
        shellState: "running",
        restartOnMount: true,
      },
    };
    let state: Record<string, unknown> = { tabs: [tab] };
    const stateRef = { current: state };
    const updateTab = vi.fn((tabId: string, mutator: (t: Tab) => Tab) => {
      expect(tabId).toBe("shell-1");
      tab = mutator(tab);
      state = { tabs: [tab] };
      stateRef.current = state;
    });
    const appendSystem = vi.fn();
    harness.invoke.mockImplementation((command: string) =>
      command === "shell_open"
        ? Promise.reject(new Error("spawn failed"))
        : Promise.resolve(undefined),
    );

    subscribeShellStreams({
      updateTab,
      stateRef,
      appendSystem,
      shellInheritEnvRef: { current: true },
    });
    await Promise.resolve();

    harness.fireEvent("shell-exit", { tabId: "shell-1", code: 0 });

    await vi.waitFor(() => {
      expect(appendSystem).toHaveBeenCalledWith(
        "Shell tab exited and could not be restarted: Error: spawn failed",
      );
    });

    expect(tab.shell).toMatchObject({
      shellState: "exited",
      exitCode: -1,
    });
    expect(tab.shell?.restartOnMount).toBeUndefined();
  });
});
