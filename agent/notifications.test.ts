import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import { markFrontendReady } from "./mutation-ack";
import { dismissNotification, notify } from "./notifications";

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
  return {
    state,
    sent,
    deps: { send: (m: Record<string, unknown>) => sent.push(m) },
  };
}

describe("notifications", () => {
  describe("notify", () => {
    it("rejects bad inputs", async () => {
      const { state, deps } = makeFixture();
      await expect(notify(state, deps, null)).resolves.toEqual({
        ok: false,
        error: "notify requires { title }",
      });
      await expect(notify(state, deps, {})).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("title required"),
      });
      await expect(notify(state, deps, { title: "  " })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("title required"),
      });
    });

    it("emits a notification message and assigns an id when none given", async () => {
      const { state, deps, sent } = makeFixture();
      await notify(state, deps, { title: "Hello" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "notification",
        notification: expect.objectContaining({
          title: "Hello",
          kind: "info",
        }),
      });
      const note = (sent[0].notification as { id: string }).id;
      expect(note).toMatch(/^n[a-z0-9]+-1$/);
    });

    it("preserves explicit id, kind, message, and durationMs:null (sticky)", async () => {
      const { state, deps, sent } = makeFixture();
      await notify(state, deps, {
        id: "my-id",
        title: "T",
        message: "M",
        kind: "warning",
        durationMs: null,
      });
      expect(sent[0].notification).toMatchObject({
        id: "my-id",
        title: "T",
        message: "M",
        kind: "warning",
        durationMs: null,
      });
    });

    it("ignores invalid kind / actions", async () => {
      const { state, deps, sent } = makeFixture();
      await notify(state, deps, {
        title: "x",
        kind: "bogus",
        actions: [{ bad: 1 }, { label: "Yes", action: "ok" }],
      });
      expect(sent[0].notification).toMatchObject({
        kind: "info",
        actions: [{ label: "Yes", action: "ok" }],
      });
    });

    it("post-ready calls become acked promises", () => {
      const { state, deps } = makeFixture();
      markFrontendReady(state);
      const p = notify(state, deps, { title: "x" });
      // Promise stays pending until ack/timeout — verify shape only.
      expect(typeof p.then).toBe("function");
    });
  });

  describe("dismissNotification", () => {
    it("rejects bad ids", async () => {
      const { state, deps } = makeFixture();
      await expect(dismissNotification(state, deps, null)).resolves.toEqual({
        ok: false,
        error: "id required",
      });
      await expect(dismissNotification(state, deps, "")).resolves.toEqual({
        ok: false,
        error: "id required",
      });
    });

    it("emits notification_dismiss with the id and a mutationId", async () => {
      const { state, deps, sent } = makeFixture();
      await dismissNotification(state, deps, "x");
      expect(sent[0]).toMatchObject({ type: "notification_dismiss", id: "x" });
      expect(sent[0].mutationId).toMatch(/^m/);
    });
  });
});
