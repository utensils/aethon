import { describe, expect, it, vi } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";
import { buildEditorApi } from "./aethon-api-editor";
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
  const send = (m: Record<string, unknown>) => sent.push(m);
  return {
    state,
    sent,
    editor: buildEditorApi(state, { send }),
  };
}

describe("buildEditorApi", () => {
  it("rejects missing path without sending", async () => {
    const { editor, sent } = makeFixture();
    await expect(editor.openFile({ path: "   " })).resolves.toEqual({
      ok: false,
      error: "path required",
    });
    expect(sent).toHaveLength(0);
  });

  it("forwards open_file with the active tab cwd", async () => {
    const { state, sent, editor } = makeFixture();
    markFrontendReady(state);
    state.tabProjectCwds.set("tab-1", "/repo");

    const p = state.tabContext.run("tab-1", () =>
      editor.openFile({ path: "src/App.tsx" }),
    );

    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "editor_query",
      op: "open_file",
      args: {
        path: "src/App.tsx",
        cwd: "/repo",
      },
    });
    ackMutation(state, msg.mutationId as string, true, undefined, {
      filePath: "/repo/src/App.tsx",
      rootPath: "/repo",
    });
    await expect(p).resolves.toEqual({
      ok: true,
      data: { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
    });
  });

  it("forwards rootPath only when provided", async () => {
    const { state, sent, editor } = makeFixture();
    markFrontendReady(state);
    state.currentProjectCwd = "/repo";

    const p = editor.openFile({
      path: "config.toml",
      rootPath: "/Users/test/.aethon",
    });
    const msg = sent.at(-1)!;
    expect(msg).toMatchObject({
      type: "editor_query",
      op: "open_file",
      args: {
        path: "config.toml",
        cwd: "/repo",
        rootPath: "/Users/test/.aethon",
      },
    });
    ackMutation(state, msg.mutationId as string, true);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("returns frontend_not_ready when the handshake never completes", async () => {
    vi.useFakeTimers();
    try {
      const { editor } = makeFixture();
      const p = editor.openFile({ path: "README.md" });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({
        ok: false,
        error: "frontend_not_ready",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
