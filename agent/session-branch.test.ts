import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureTabMock = vi.hoisted(() => vi.fn());
const forkSqliteSessionMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("./tab-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tab-lifecycle")>();
  return {
    ...actual,
    ensureTab: ensureTabMock,
  };
});

vi.mock("./session-sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-sqlite")>();
  return {
    ...actual,
    forkSqliteSession: forkSqliteSessionMock,
  };
});

import { handleForkSession, handleRollbackSession } from "./session-branch";
import type { AethonAgentState } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";

let sessionsDir: string;

function makeDeps() {
  const sent: Record<string, unknown>[] = [];
  const deps = {
    send: (m: Record<string, unknown>) => sent.push(m),
    scheduleStateFileWrite: () => {},
    loadHooks: {},
  } as unknown as DispatcherDeps;
  return { deps, sent };
}

interface FakeSm {
  getEntry: ReturnType<typeof vi.fn>;
  branch: ReturnType<typeof vi.fn>;
  createBranchedSession: ReturnType<typeof vi.fn>;
}

function makeState(opts?: {
  streaming?: boolean;
  promptInFlight?: boolean;
  branchedPath?: string | undefined;
  hasTab?: boolean;
}): { state: AethonAgentState; sm: FakeSm; abort: ReturnType<typeof vi.fn> } {
  const sm: FakeSm = {
    getEntry: vi.fn((id: string) =>
      id === "e2"
        ? { id: "e2", timestamp: "2026-06-02T13:00:00.000Z" }
        : undefined,
    ),
    branch: vi.fn(),
    createBranchedSession: vi.fn(() =>
      opts && "branchedPath" in opts
        ? opts.branchedPath
        : join(sessionsDir, "t1", "branch.jsonl"),
    ),
  };
  const abort = vi.fn(() => Promise.resolve());
  const session = {
    sessionManager: sm,
    abort,
    isStreaming: opts?.streaming ?? false,
  };
  const tab = {
    id: "t1",
    session,
    promptInFlight: opts?.promptInFlight ?? false,
    agentEndFired: false,
    queuedCount: 0,
  };
  const tabs = new Map<string, unknown>();
  if (opts?.hasTab !== false) tabs.set("t1", tab);
  const state = {
    sessionsDir,
    tabs,
    tabProjectCwds: new Map([["t1", "/proj"]]),
    frontendState: new Map(),
    currentAgentTabId: undefined,
  } as unknown as AethonAgentState;
  return { state, sm, abort };
}

function msg(extra: Partial<InboundMessage>): InboundMessage {
  return { type: "x", ...extra };
}

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "aethon-branch-"));
  ensureTabMock.mockReset();
  forkSqliteSessionMock.mockReset();
  forkSqliteSessionMock.mockReturnValue(true);
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("handleRollbackSession", () => {
  it("branches at the entry and emits session_rolled_back", async () => {
    const { state, sm } = makeState();
    const { deps, sent } = makeDeps();
    await handleRollbackSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "e2" }),
    );
    expect(sm.branch).toHaveBeenCalledWith("e2");
    expect(sent).toContainEqual({
      type: "session_rolled_back",
      tabId: "t1",
      entryId: "e2",
    });
  });

  it("aborts an in-flight turn before branching", async () => {
    const { state, sm, abort } = makeState({ promptInFlight: true });
    const { deps } = makeDeps();
    await handleRollbackSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "e2" }),
    );
    expect(abort).toHaveBeenCalled();
    expect(sm.branch).toHaveBeenCalledWith("e2");
  });

  it("errors on an unknown entry without branching", async () => {
    const { state, sm } = makeState();
    const { deps, sent } = makeDeps();
    await handleRollbackSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "ghost" }),
    );
    expect(sm.branch).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === "error")).toBe(true);
  });

  it("errors on an unknown tab", async () => {
    const { state } = makeState({ hasTab: false });
    const { deps, sent } = makeDeps();
    await handleRollbackSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "e2" }),
    );
    expect(sent.some((m) => m.type === "error")).toBe(true);
  });

  it("opens a mirrored restored tab before rolling back", async () => {
    const { state, sm } = makeState();
    const rec = state.tabs.get("t1");
    if (!rec) throw new Error("missing test tab");
    state.tabs.delete("t1");
    state.tabProjectCwds.delete("t1");
    state.frontendState.set("/tabs", [
      { id: "t1", kind: "agent", cwd: "/proj" },
    ]);
    ensureTabMock.mockImplementation(() => {
      state.tabs.set("t1", rec);
      return rec;
    });
    const { deps, sent } = makeDeps();

    await handleRollbackSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "e2" }),
    );

    expect(ensureTabMock).toHaveBeenCalledWith(state, deps, "t1", {
      cwdOverride: "/proj",
    });
    expect(sm.branch).toHaveBeenCalledWith("e2");
    expect(sent).toContainEqual({
      type: "session_rolled_back",
      tabId: "t1",
      entryId: "e2",
    });
  });

  it("requires tabId and entryId", async () => {
    const { state } = makeState();
    const { deps, sent } = makeDeps();
    await handleRollbackSession(state, deps, msg({ tabId: "t1" }));
    expect(sent.some((m) => m.type === "error")).toBe(true);
  });
});

describe("handleForkSession", () => {
  it("creates a branched session and emits session_forked", async () => {
    const { state, sm } = makeState();
    const { deps, sent } = makeDeps();
    await handleForkSession(state, deps, msg({ tabId: "t1", entryId: "e2" }));
    expect(sm.createBranchedSession).toHaveBeenCalledWith("e2");
    const forked = sent.find((m) => m.type === "session_forked");
    expect(forked).toBeTruthy();
    expect(typeof forked?.newTabId).toBe("string");
    expect((forked?.newTabId as string).length).toBeGreaterThan(0);
    expect(forked).not.toHaveProperty("sourcePath");
    expect(forked?.label).toMatch(/^Fork of /);
    expect(forked?.cwd).toBe("/proj");
  });

  it("emits a fork event even when pi does not produce a sidecar path", async () => {
    const { state } = makeState({ branchedPath: undefined });
    const { deps, sent } = makeDeps();
    await handleForkSession(state, deps, msg({ tabId: "t1", entryId: "e2" }));
    expect(sent.some((m) => m.type === "error")).toBe(false);
    expect(sent.some((m) => m.type === "session_forked")).toBe(true);
  });

  it("does not emit session_forked when sqlite state copy fails", async () => {
    forkSqliteSessionMock.mockReturnValue(false);
    const { state } = makeState();
    const { deps, sent } = makeDeps();
    await handleForkSession(state, deps, msg({ tabId: "t1", entryId: "e2" }));
    expect(sent).toContainEqual({
      type: "error",
      tabId: "t1",
      message: "fork_session: failed to copy session state",
    });
    expect(sent.some((m) => m.type === "session_forked")).toBe(false);
  });

  it("errors on an unknown entry", async () => {
    const { state, sm } = makeState();
    const { deps, sent } = makeDeps();
    await handleForkSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "ghost" }),
    );
    expect(sm.createBranchedSession).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === "error")).toBe(true);
  });

  it("opens a mirrored restored tab before forking", async () => {
    const { state, sm } = makeState();
    const rec = state.tabs.get("t1");
    if (!rec) throw new Error("missing test tab");
    state.tabs.delete("t1");
    state.tabProjectCwds.delete("t1");
    state.frontendState.set("/tabs", [
      { id: "t1", kind: "agent", cwd: "/proj" },
    ]);
    ensureTabMock.mockImplementation(() => {
      state.tabs.set("t1", rec);
      return rec;
    });
    const { deps, sent } = makeDeps();

    await handleForkSession(state, deps, msg({ tabId: "t1", entryId: "e2" }));

    expect(ensureTabMock).toHaveBeenCalledWith(state, deps, "t1", {
      cwdOverride: "/proj",
    });
    expect(sm.createBranchedSession).toHaveBeenCalledWith("e2");
    const forked = sent.find((m) => m.type === "session_forked");
    expect(forked?.cwd).toBe("/proj");
    expect(sent.some((m) => m.type === "error")).toBe(false);
  });

  it("uses an explicit cwd hint to open a restored tab before forking", async () => {
    const { state, sm } = makeState();
    const rec = state.tabs.get("t1");
    if (!rec) throw new Error("missing test tab");
    state.tabs.delete("t1");
    state.tabProjectCwds.delete("t1");
    ensureTabMock.mockImplementation(() => {
      state.tabs.set("t1", rec);
      return rec;
    });
    const { deps, sent } = makeDeps();

    await handleForkSession(
      state,
      deps,
      msg({ tabId: "t1", entryId: "e2", cwd: "/repo/from-message" }),
    );

    expect(ensureTabMock).toHaveBeenCalledWith(state, deps, "t1", {
      cwdOverride: "/repo/from-message",
    });
    expect(sm.createBranchedSession).toHaveBeenCalledWith("e2");
    const forked = sent.find((m) => m.type === "session_forked");
    expect(forked?.cwd).toBe("/repo/from-message");
    expect(sent.some((m) => m.type === "error")).toBe(false);
  });
});
