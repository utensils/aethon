// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useCloseTabActions, type CloseTabDeps } from "./closeTab";
import { OVERVIEW_TAB_ID, makeEmptyTab, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../monaco/editor-buffers", () => ({
  disposeEditorBuffer: vi.fn(),
}));

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function buildDeps(
  initial: Record<string, unknown>,
  overrides: Partial<CloseTabDeps> = {},
): {
  deps: CloseTabDeps;
  stateRef: MutableRefObject<Record<string, unknown>>;
  apply: () => Record<string, unknown>;
  setStateCalls: Array<
    (prev: Record<string, unknown>) => Record<string, unknown>
  >;
} {
  let current = initial;
  const stateRef = ref<Record<string, unknown>>(initial);
  const setStateCalls: Array<
    (prev: Record<string, unknown>) => Record<string, unknown>
  > = [];
  const setState = vi.fn((updater: unknown) => {
    if (typeof updater !== "function") return;
    const fn = updater as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    setStateCalls.push(fn);
    current = fn(current);
    stateRef.current = current;
  });
  const deps: CloseTabDeps = {
    setState,
    stateRef,
    projectsRef: ref<ProjectsState>({
      activeId: null,
      projects: [],
    } as unknown as ProjectsState),
    promptCloseShellTabConfirmation: vi.fn(() => Promise.resolve(true)),
    shellPromptBeforeCloseRef: ref(false),
    dispatchTerminalReplay: vi.fn(),
    closedTabsRef: ref([]),
    clearActiveProject: vi.fn(),
    setActiveProjectById: vi.fn(() => true),
    newTab: vi.fn(),
    newShellTab: vi.fn(),
    newEditorTab: vi.fn(),
    ...overrides,
  };
  return { deps, stateRef, apply: () => current, setStateCalls };
}

function makeTab(id: string, kind: Tab["kind"] = "agent"): Tab {
  const t = makeEmptyTab(id, id, null, kind);
  if (kind === "shell") {
    t.shell = {
      cwd: "",
      command: "",
      args: [],
      shareMode: "private",
      shellState: "running",
    };
  }
  return t;
}

describe("closeTabNow → overview fallback", () => {
  it("falls back to OVERVIEW_TAB_ID when closing the last agent tab", () => {
    const agent = makeTab("agent-1", "agent");
    const { deps, apply } = buildDeps({
      tabs: [agent],
      activeTabId: "agent-1",
    });
    const { closeTabNow } = useCloseTabActions(deps);
    closeTabNow("agent-1");
    const next = apply();
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(next.empty).toBe(true);
    expect(next.hasTabs).toBe(false);
  });

  it("falls back to OVERVIEW_TAB_ID when only shells remain", () => {
    // Closing the lone agent tab leaves only a shell; the canvas should
    // return to the overview rather than activating the shell, which
    // has no canvas of its own.
    const agent = makeTab("agent-1", "agent");
    const shell = makeTab("shell-1", "shell");
    const { deps, apply } = buildDeps({
      tabs: [agent, shell],
      activeTabId: "agent-1",
    });
    const { closeTabNow } = useCloseTabActions(deps);
    closeTabNow("agent-1");
    const next = apply();
    expect((next.tabs as Tab[]).map((t) => t.id)).toEqual(["shell-1"]);
    expect(next.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(next.empty).toBe(true);
    expect(next.hasTabs).toBe(true);
  });

  it("activates the most-recent remaining agent tab", () => {
    const t1 = makeTab("agent-1", "agent");
    const t2 = makeTab("agent-2", "agent");
    const { deps, apply } = buildDeps({
      tabs: [t1, t2],
      activeTabId: "agent-2",
    });
    const { closeTabNow } = useCloseTabActions(deps);
    closeTabNow("agent-2");
    const next = apply();
    expect(next.activeTabId).toBe("agent-1");
  });

  it("does not switch the active tab when closing a non-active tab", () => {
    const t1 = makeTab("agent-1", "agent");
    const t2 = makeTab("agent-2", "agent");
    const { deps, apply } = buildDeps({
      tabs: [t1, t2],
      activeTabId: "agent-1",
    });
    const { closeTabNow } = useCloseTabActions(deps);
    closeTabNow("agent-2");
    const next = apply();
    expect(next.activeTabId).toBe("agent-1");
  });

  it("activates an editor tab if it's the only remaining session kind", () => {
    const agent = makeTab("agent-1", "agent");
    const editor = makeTab("editor-1", "editor");
    const { deps, apply } = buildDeps({
      tabs: [agent, editor],
      activeTabId: "agent-1",
    });
    const { closeTabNow } = useCloseTabActions(deps);
    closeTabNow("agent-1");
    const next = apply();
    expect(next.activeTabId).toBe("editor-1");
  });
});

describe("closeTab — idle-shell guard", () => {
  it("skips the prompt when the shell is idle (direnv/nix-shell at a prompt)", async () => {
    // An idle bash sitting at a $ prompt has no foreground job other
    // than itself — closing it terminates a passive shell, not in-flight
    // work, so the confirmation is just friction. TDD: this fails until
    // closeTab asks isShellBusy before prompting.
    const shell = makeTab("sh-1", "shell");
    const promptFn = vi.fn(() => Promise.resolve(true));
    const isShellBusy = vi.fn(() => Promise.resolve(false));
    const { deps, apply } = buildDeps(
      { tabs: [shell], activeTabId: "sh-1" },
      {
        promptCloseShellTabConfirmation: promptFn,
        shellPromptBeforeCloseRef: ref(true),
        isShellBusy,
      },
    );
    const { closeTab } = useCloseTabActions(deps);
    closeTab("sh-1");
    // Wait for the (promise-microtask) busy check to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(isShellBusy).toHaveBeenCalledWith("sh-1");
    expect(promptFn).not.toHaveBeenCalled();
    expect(apply().tabs).toEqual([]);
  });

  it("still prompts when the shell has a foreground job", async () => {
    const shell = makeTab("sh-1", "shell");
    const promptFn = vi.fn(() => Promise.resolve(false));
    const isShellBusy = vi.fn(() => Promise.resolve(true));
    const { deps, apply } = buildDeps(
      { tabs: [shell], activeTabId: "sh-1" },
      {
        promptCloseShellTabConfirmation: promptFn,
        shellPromptBeforeCloseRef: ref(true),
        isShellBusy,
      },
    );
    const { closeTab } = useCloseTabActions(deps);
    closeTab("sh-1");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(isShellBusy).toHaveBeenCalledWith("sh-1");
    expect(promptFn).toHaveBeenCalledWith("sh-1");
    // User declined — tab stays open.
    expect((apply().tabs as Tab[]).map((t) => t.id)).toEqual(["sh-1"]);
  });

  it("falls back to prompting when isShellBusy throws (assume busy)", async () => {
    const shell = makeTab("sh-1", "shell");
    const promptFn = vi.fn(() => Promise.resolve(true));
    const isShellBusy = vi.fn(() =>
      Promise.reject(new Error("ipc lost")),
    );
    const { deps } = buildDeps(
      { tabs: [shell], activeTabId: "sh-1" },
      {
        promptCloseShellTabConfirmation: promptFn,
        shellPromptBeforeCloseRef: ref(true),
        isShellBusy,
      },
    );
    const { closeTab } = useCloseTabActions(deps);
    closeTab("sh-1");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(promptFn).toHaveBeenCalled();
  });

  it("respects shellPromptBeforeClose=false regardless of busy state", () => {
    const shell = makeTab("sh-1", "shell");
    const promptFn = vi.fn(() => Promise.resolve(true));
    const isShellBusy = vi.fn(() => Promise.resolve(true));
    const { deps, apply } = buildDeps(
      { tabs: [shell], activeTabId: "sh-1" },
      {
        promptCloseShellTabConfirmation: promptFn,
        shellPromptBeforeCloseRef: ref(false),
        isShellBusy,
      },
    );
    const { closeTab } = useCloseTabActions(deps);
    closeTab("sh-1");
    expect(promptFn).not.toHaveBeenCalled();
    expect(isShellBusy).not.toHaveBeenCalled();
    expect(apply().tabs).toEqual([]);
  });

  it("does not prompt for already-exited shells (existing behaviour)", () => {
    const shell = makeTab("sh-1", "shell");
    if (shell.shell) shell.shell.shellState = "exited";
    const promptFn = vi.fn(() => Promise.resolve(true));
    const { deps, apply } = buildDeps(
      { tabs: [shell], activeTabId: "sh-1" },
      {
        promptCloseShellTabConfirmation: promptFn,
        shellPromptBeforeCloseRef: ref(true),
      },
    );
    const { closeTab } = useCloseTabActions(deps);
    closeTab("sh-1");
    expect(promptFn).not.toHaveBeenCalled();
    expect(apply().tabs).toEqual([]);
  });
});
