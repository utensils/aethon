import { beforeEach, describe, expect, it, vi } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "../state";
import {
  _resetForTests,
  ensurePrepared,
  ensureFetched,
  getCachedEnv,
  maybeWarnColdRun,
  onDevshellEvent,
  refresh,
  seedPreparedEnv,
} from "./client";
import { ackMutation, markFrontendReady } from "../mutation-ack";

const baseOpts: AethonAgentStateOptions = {
  userDir: "/tmp/aethon-test",
  stateFile: "/tmp/aethon-test/state.json",
  sessionsDir: "/tmp/aethon-test/sessions",
  docsDir: undefined,
  projectRoot: undefined,
  releaseMode: false,
  bootLayoutFile: undefined,
  layoutSlotsFile: undefined,
  statePayloadWarnBytes: 64 * 1024,
  statePayloadHardBytes: 512 * 1024,
  statePayloadWarnKb: 64,
  statePayloadHardKb: 512,
};

interface SendCall {
  type: string;
  op?: string;
  args?: Record<string, unknown>;
  mutationId?: string;
}

interface Harness {
  state: AethonAgentState;
  deps: { send: ReturnType<typeof vi.fn> };
  /** Captured `send()` calls. */
  sent: SendCall[];
}

function makeHarness(): Harness {
  const state = new AethonAgentState(baseOpts);
  markFrontendReady(state); // skip handshake wait
  const sent: SendCall[] = [];
  const send = vi.fn((obj: Record<string, unknown>) => {
    sent.push(obj as SendCall);
  });
  return { state, deps: { send }, sent };
}

function ackLastWith(
  harness: Harness,
  success: boolean,
  data?: unknown,
  error?: string,
): void {
  const last = harness.sent[harness.sent.length - 1];
  if (!last?.mutationId) throw new Error("no pending mutation to ack");
  ackMutation(harness.state, last.mutationId, success, error, data);
}

beforeEach(() => {
  _resetForTests();
});

describe("getCachedEnv", () => {
  it("returns empty + cold on miss and fires a background fetch", () => {
    const h = makeHarness();
    const result = h.deps;
    const { env, kind, hot } = getCachedEnv(h.state, result, "/proj");
    expect(env).toEqual({});
    expect(kind).toBeNull();
    expect(hot).toBe(false);
    // Background fetch should have been scheduled.
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toMatchObject({
      type: "devshell_query",
      op: "env_for_path",
      args: { cwd: "/proj" },
    });
  });

  it("returns the cached env after ensureFetched resolves", async () => {
    const h = makeHarness();
    const fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/nix/store/abc/bin", RUSTC: "/nix/store/xyz/bin/rustc" },
      stale: false,
    });
    await fetchP;
    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBe("flake");
    expect(env).toEqual({
      PATH: "/nix/store/abc/bin",
      RUSTC: "/nix/store/xyz/bin/rustc",
    });
  });

  it("flushes env when enabled is 'never'", async () => {
    const h = makeHarness();
    const fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, { enabled: "never", kind: null, env: {} });
    await fetchP;
    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBeNull();
    expect(env).toEqual({});
  });

  it("keeps a known-empty env hot while a refresh fetch is in flight", async () => {
    const h = makeHarness();
    let fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, { enabled: "never", kind: null, env: {} });
    await fetchP;

    fetchP = ensureFetched(h.state, h.deps, "/proj");
    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBeNull();
    expect(env).toEqual({});

    ackLastWith(h, true, { enabled: "never", kind: null, env: {} });
    await fetchP;
  });

  it("preserves previous env on a failed re-fetch (marks stale)", async () => {
    const h = makeHarness();
    // 1st fetch — success
    let p = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/x" },
    });
    await p;
    // 2nd fetch — failure should NOT clear the cached env.
    p = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, false, undefined, "resolver wedged");
    await p;
    const { env, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(env).toEqual({ PATH: "/x" });
    expect(hot).toBe(true);
  });

  it("keeps using a prepared env while a refresh fetch is in flight", async () => {
    const h = makeHarness();
    const p = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/nix/store/old/bin", IN_NIX_SHELL: "impure" },
    });
    await p;

    void ensureFetched(h.state, h.deps, "/proj");

    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBe("flake");
    expect(env).toEqual({
      PATH: "/nix/store/old/bin",
      IN_NIX_SHELL: "impure",
    });
  });
});

describe("seedPreparedEnv", () => {
  it("seeds only the supervisor-marked devshell env keys", () => {
    const h = makeHarness();
    seedPreparedEnv(
      "/proj",
      {
        AETHON_WORKER_DEVSHELL_ENV_KEYS: JSON.stringify([
          "PATH",
          "IN_NIX_SHELL",
        ]),
        PATH: "/nix/store/bin",
        IN_NIX_SHELL: "impure",
        PWD: "/wrong",
        SHLVL: "7",
        "BASH_FUNC_menu%%": "() { echo leaked; }",
      },
      "flake",
    );

    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBe("flake");
    expect(env).toEqual({
      PATH: "/nix/store/bin",
      IN_NIX_SHELL: "impure",
    });
    expect(h.sent.length).toBe(0);
  });

  it("keeps the cache cold when prepared env keys are missing", () => {
    const h = makeHarness();
    seedPreparedEnv(
      "/proj",
      { PATH: "/nix/store/bin", PWD: "/wrong" },
      "flake",
    );

    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(false);
    expect(kind).toBeNull();
    expect(env).toEqual({});
    expect(h.sent[0]).toMatchObject({
      type: "devshell_query",
      op: "env_for_path",
      args: { cwd: "/proj" },
    });
  });
});

describe("ensurePrepared", () => {
  it("sends blocking prepare query and seeds the cache", async () => {
    const h = makeHarness();
    const p = ensurePrepared(h.state, h.deps, "/proj");
    expect(h.sent[0]).toMatchObject({
      type: "devshell_query",
      op: "prepare_for_path",
      args: { cwd: "/proj", includeEnv: true },
    });
    ackLastWith(h, true, {
      enabled: "auto",
      state: "ready",
      kind: "direnv",
      env: { PATH: "/nix/store/bin", IN_NIX_SHELL: "impure" },
      stale: false,
    });
    await p;
    const { env, kind, hot } = getCachedEnv(h.state, h.deps, "/proj");
    expect(hot).toBe(true);
    expect(kind).toBe("direnv");
    expect(env).toEqual({ PATH: "/nix/store/bin", IN_NIX_SHELL: "impure" });
  });

  it("throws when blocking prepare is rejected", async () => {
    const h = makeHarness();
    const p = ensurePrepared(h.state, h.deps, "/proj");
    ackLastWith(h, false, undefined, "devshell required");
    await expect(p).rejects.toThrow("devshell required");
  });
});

describe("onDevshellEvent", () => {
  it("keeps existing env hot under a root on ready while refreshing it", async () => {
    const h = makeHarness();
    const p1 = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/old" },
    });
    await p1;
    const p2 = ensureFetched(h.state, h.deps, "/proj/sub");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/old-sub" },
    });
    await p2;

    onDevshellEvent(h.state, h.deps, {
      kind: "flake",
      root: "/proj",
      status: "ready",
    });
    const root = getCachedEnv(h.state, h.deps, "/proj");
    const sub = getCachedEnv(h.state, h.deps, "/proj/sub");
    expect(root.hot).toBe(true);
    expect(sub.hot).toBe(true);
    expect(root.env).toEqual({ PATH: "/old" });
    expect(sub.env).toEqual({ PATH: "/old-sub" });
    expect(h.sent.filter((c) => c.op === "env_for_path")).toHaveLength(4);
  });

  it("does not start a duplicate ready refresh while a fetch is already in flight", async () => {
    const h = makeHarness();
    const p1 = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/old" },
    });
    await p1;

    const refreshP = ensureFetched(h.state, h.deps, "/proj");
    expect(h.sent.filter((c) => c.op === "env_for_path")).toHaveLength(2);

    onDevshellEvent(h.state, h.deps, {
      kind: "flake",
      root: "/proj",
      status: "ready",
    });

    expect(h.sent.filter((c) => c.op === "env_for_path")).toHaveLength(2);
    const duringRefresh = getCachedEnv(h.state, h.deps, "/proj");
    expect(duringRefresh.hot).toBe(true);
    expect(duringRefresh.env).toEqual({ PATH: "/old" });

    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/new" },
    });
    await refreshP;

    expect(getCachedEnv(h.state, h.deps, "/proj").env).toEqual({
      PATH: "/new",
    });
  });

  it("does not invalidate cache entries under unrelated roots", async () => {
    const h = makeHarness();
    const p = ensureFetched(h.state, h.deps, "/proj-a");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/a" },
    });
    await p;
    onDevshellEvent(h.state, h.deps, {
      kind: "flake",
      root: "/proj-b",
      status: "ready",
    });
    const { env, hot } = getCachedEnv(h.state, h.deps, "/proj-a");
    expect(hot).toBe(true);
    expect(env).toEqual({ PATH: "/a" });
  });
});

describe("refresh", () => {
  it("keeps cached env hot for the root while sending a refresh query", async () => {
    const h = makeHarness();
    const p = ensureFetched(h.state, h.deps, "/proj");
    ackLastWith(h, true, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/old" },
    });
    await p;

    const refreshP = refresh(h.state, h.deps, "/proj");
    // The old devshell env should remain usable until the refresh result lands.
    const beforeAck = getCachedEnv(h.state, h.deps, "/proj");
    expect(beforeAck.hot).toBe(true);
    expect(beforeAck.env).toEqual({ PATH: "/old" });

    // Now ack the refresh query.
    // Two acks may be pending — drain them in order.
    while (h.sent.length > 0) {
      const last = h.sent[h.sent.length - 1];
      if (!last?.mutationId) break;
      ackMutation(h.state, last.mutationId, true, undefined, {});
      h.sent.pop();
    }
    await refreshP;

    const sendCalls = h.deps.send.mock.calls.map((c) => c[0]);
    expect(sendCalls.some((c) => (c as SendCall).op === "refresh")).toBe(true);
  });
});

describe("maybeWarnColdRun", () => {
  it("only emits once per cwd", () => {
    expect(maybeWarnColdRun("/proj", "flake")).toBe(true);
    expect(maybeWarnColdRun("/proj", "flake")).toBe(false);
    expect(maybeWarnColdRun("/other", "direnv")).toBe(true);
  });
});
