import { beforeEach, describe, expect, it } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "../state";
import { ackMutation, markFrontendReady } from "../mutation-ack";
import { _resetForTests, ensureFetched } from "./client";
import { buildDevshellSpawnHook } from "./spawnHook";

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

function makeHarness() {
  const state = new AethonAgentState(baseOpts);
  markFrontendReady(state);
  const sent: SendCall[] = [];
  const deps = {
    send: (obj: Record<string, unknown>) => {
      sent.push(obj as SendCall);
    },
  };
  return { state, deps, sent };
}

function ackLast(harness: ReturnType<typeof makeHarness>, data: unknown) {
  const last = harness.sent[harness.sent.length - 1];
  if (!last?.mutationId) throw new Error("no pending mutation to ack");
  ackMutation(harness.state, last.mutationId, true, undefined, data);
}

beforeEach(() => {
  _resetForTests();
});

describe("buildDevshellSpawnHook", () => {
  it("returns ctx unchanged on cold cache (and warns once)", () => {
    const h = makeHarness();
    const hook = buildDevshellSpawnHook(h.state, h.deps);
    const ctx = {
      command: "cargo --version",
      cwd: "/proj",
      env: { PATH: "/usr/bin", HOME: "/home/u" },
    };
    const result = hook(ctx);
    // Cold — no merge, no copy.
    expect(result).toBe(ctx);
    // Background fetch should be in flight.
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toMatchObject({
      type: "devshell_query",
      op: "env_for_path",
      args: { cwd: "/proj" },
    });
  });

  it("merges cached env over ctx env, devshell PATH winning", async () => {
    const h = makeHarness();
    const fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLast(h, {
      enabled: "auto",
      kind: "flake",
      env: { PATH: "/nix/store/abc/bin", RUSTC: "/nix/store/xyz/bin/rustc" },
      stale: false,
    });
    await fetchP;

    const hook = buildDevshellSpawnHook(h.state, h.deps);
    const ctx = {
      command: "cargo --version",
      cwd: "/proj",
      env: { PATH: "/usr/bin", HOME: "/home/u", FOO: "bar" },
    };
    const result = hook(ctx);
    // Devshell PATH wins; host HOME / FOO survive; RUSTC added.
    expect(result.env).toMatchObject({
      PATH: "/nix/store/abc/bin",
      HOME: "/home/u",
      FOO: "bar",
      RUSTC: "/nix/store/xyz/bin/rustc",
    });
    // Original ctx not mutated in place.
    expect(ctx.env).not.toBe(result.env);
    expect(ctx.env.PATH).toBe("/usr/bin");
  });

  it("passes through unchanged when cached env is empty (no devshell)", async () => {
    const h = makeHarness();
    const fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLast(h, { enabled: "auto", kind: null, env: {}, stale: false });
    await fetchP;

    const hook = buildDevshellSpawnHook(h.state, h.deps);
    const ctx = {
      command: "ls",
      cwd: "/proj",
      env: { PATH: "/usr/bin" },
    };
    const result = hook(ctx);
    expect(result).toBe(ctx);
  });

  it("passes through unchanged when enabled='never'", async () => {
    const h = makeHarness();
    const fetchP = ensureFetched(h.state, h.deps, "/proj");
    ackLast(h, { enabled: "never", kind: null, env: {}, stale: false });
    await fetchP;

    const hook = buildDevshellSpawnHook(h.state, h.deps);
    const ctx = {
      command: "ls",
      cwd: "/proj",
      env: { PATH: "/usr/bin" },
    };
    const result = hook(ctx);
    expect(result).toBe(ctx);
  });
});
