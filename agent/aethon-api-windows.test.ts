import { describe, expect, it, vi } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";
import { buildWindowsApi } from "./aethon-api-windows";
import { ackMutation, markFrontendReady } from "./mutation-ack";

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

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  const api = buildWindowsApi(state, { send: (m) => sent.push(m) });
  return { state, sent, api };
}

describe("buildWindowsApi", () => {
  it("returns frontend_not_ready when the handshake never completes", async () => {
    vi.useFakeTimers();
    try {
      const { api, sent } = makeFixture();
      const p = api.list();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({
        ok: false,
        error: "frontend_not_ready",
      });
      expect(sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("openCanvas forwards native_window_query with owner tab fallback", async () => {
    const { state, sent, api } = makeFixture();
    state.frontendState.set("/tabs", [
      { id: "default", active: false },
      { id: "tab-2", active: true },
    ]);
    markFrontendReady(state);
    const p = api.openCanvas({
      id: "Workpad",
      title: "Workpad",
      components: [{ id: "root", type: "card" }],
    });
    await Promise.resolve();
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "native_window_query",
      op: "open_canvas",
      args: {
        id: "Workpad",
        title: "Workpad",
        tabId: "tab-2",
      },
    });
    ackMutation(state, msg.mutationId as string, true, undefined, {
      id: "Workpad",
      label: "aethon-canvas-Workpad",
      kind: "canvas",
      title: "Workpad",
      tabId: "tab-2",
      restoreOnLaunch: true,
      components: [{ id: "root", type: "card" }],
      state: {},
    });
    await expect(p).resolves.toMatchObject({ ok: true });
    expect(state.nativeWindows.get("Workpad")).toMatchObject({
      id: "Workpad",
      title: "Workpad",
      componentCount: 1,
      tabId: "tab-2",
    });
  });

  it("validates id-bearing operations before sending", async () => {
    const { api, sent } = makeFixture();
    await expect(api.focus("")).resolves.toEqual({
      ok: false,
      error: "id required",
    });
    await expect(api.patchCanvas("w", "", 1)).resolves.toEqual({
      ok: false,
      error: "path required",
    });
    expect(sent).toHaveLength(0);
  });

  it("openTerminal uses a PTY-startup-sized timeout", async () => {
    vi.useFakeTimers();
    try {
      const { state, sent, api } = makeFixture();
      markFrontendReady(state);
      let settled = false;
      const p = api.openTerminal({ cwd: "/repo" }).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(sent.at(-1)).toMatchObject({ op: "open_terminal" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toEqual({ ok: false, error: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openTerminal forwards terminal window queries", async () => {
    const { state, sent, api } = makeFixture();
    markFrontendReady(state);
    const p = api.openTerminal({
      id: "Term",
      title: "Terminal",
      cwd: "/repo",
      command: "zsh",
      args: ["-l"],
      activateShell: false,
    });
    await Promise.resolve();
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "native_window_query",
      op: "open_terminal",
      args: {
        id: "Term",
        title: "Terminal",
        cwd: "/repo",
        command: "zsh",
        args: ["-l"],
        activateShell: false,
      },
    });
    ackMutation(state, msg.mutationId as string, true, undefined, {
      id: "Term",
      label: "aethon-canvas-Term",
      kind: "canvas",
      title: "Terminal",
      components: [],
      state: {},
    });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it("get/getState/getCanvas forward read queries for a window id", async () => {
    const { state, sent, api } = makeFixture();
    markFrontendReady(state);

    const p = api.get("Workpad");
    await Promise.resolve();
    let msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "native_window_query",
      op: "get",
      args: { id: "Workpad" },
    });
    ackMutation(state, msg.mutationId as string, true, undefined, {
      id: "Workpad",
      label: "aethon-canvas-Workpad",
      kind: "canvas",
      title: "Workpad",
      components: [],
      state: { count: 1 },
    });
    await expect(p).resolves.toMatchObject({ ok: true });

    void api.getState("Workpad");
    await Promise.resolve();
    msg = sent.at(-1)!;
    expect(msg).toMatchObject({ op: "get_state", args: { id: "Workpad" } });

    void api.getCanvas("Workpad");
    await Promise.resolve();
    msg = sent.at(-1)!;
    expect(msg).toMatchObject({ op: "get_canvas", args: { id: "Workpad" } });
  });

  it("list replaces the known window summary cache", async () => {
    const { state, sent, api } = makeFixture();
    state.nativeWindows.set("Old", {
      id: "Old",
      label: "aethon-canvas-Old",
      kind: "canvas",
      title: "Old",
    });
    markFrontendReady(state);
    const p = api.list();
    await Promise.resolve();
    const msg = sent.at(-1)!;
    ackMutation(state, msg.mutationId as string, true, undefined, [
      {
        id: "Fresh",
        label: "aethon-canvas-Fresh",
        kind: "canvas",
        title: "Fresh",
        components: [],
        state: {},
      },
    ]);
    await expect(p).resolves.toMatchObject({
      ok: true,
      data: [
        {
          id: "Fresh",
          label: "aethon-canvas-Fresh",
          kind: "canvas",
          title: "Fresh",
          componentCount: 0,
        },
      ],
    });
    expect([...state.nativeWindows.keys()]).toEqual(["Fresh"]);
  });
});
