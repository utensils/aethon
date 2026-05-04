import { describe, expect, it } from "vitest";
import { AethonAgentState, type AethonAgentStateOptions } from "./state";

const defaultOpts: AethonAgentStateOptions = {
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

describe("AethonAgentState", () => {
  it("constructs with the supplied configuration", () => {
    const s = new AethonAgentState(defaultOpts);
    expect(s.userDir).toBe("/tmp/aethon-test");
    expect(s.releaseMode).toBe(false);
    expect(s.statePayloadHardBytes).toBe(512 * 1024);
  });

  it("starts with empty registries", () => {
    const s = new AethonAgentState(defaultOpts);
    expect(s.tabs.size).toBe(0);
    expect(s.extensionComponents.size).toBe(0);
    expect(s.extensionThemes.size).toBe(0);
    expect(s.loadedExtensions.size).toBe(0);
    expect(s.pendingMutations.size).toBe(0);
    expect(s.a2uiEventHandlers).toHaveLength(0);
    expect(s.frontendReady).toBe(false);
    expect(s.eventRoutingMode).toBe("builtin");
    expect(s.currentAgentTabId).toBeUndefined();
    expect(s.currentProjectCwd).toBeNull();
  });

  it("has a frontendReadyPromise that resolves when the resolver fires", async () => {
    const s = new AethonAgentState(defaultOpts);
    let resolved = false;
    const settled = s.frontendReadyPromise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    expect(s.frontendReadyResolvers).toHaveLength(1);
    s.frontendReadyResolvers[0]();
    await settled;
    expect(resolved).toBe(true);
  });

  it("nextMutationId increments and yields unique ids", () => {
    const s = new AethonAgentState(defaultOpts);
    const a = s.nextMutationId();
    const b = s.nextMutationId();
    expect(a).not.toBe(b);
    expect(s.mutationCounter).toBe(2);
    expect(a).toMatch(/^m[a-z0-9]+-1$/);
    expect(b).toMatch(/^m[a-z0-9]+-2$/);
  });

  it("nextNotificationId increments and yields unique ids", () => {
    const s = new AethonAgentState(defaultOpts);
    const a = s.nextNotificationId();
    const b = s.nextNotificationId();
    expect(a).not.toBe(b);
    expect(s.notificationCounter).toBe(2);
    expect(a).toMatch(/^n[a-z0-9]+-1$/);
  });

  it("readonly Maps mutate in place", () => {
    const s = new AethonAgentState(defaultOpts);
    s.extensionComponents.set("foo", { type: "card" });
    s.tabs.set("default", {
      id: "default",
      // Cast — we don't construct a real pi session in unit tests.
      session: {} as unknown as never,
      toolArgsCache: new Map(),
      promptInFlight: false,
      agentEndFired: false,
      queuedCount: 0,
    });
    expect(s.extensionComponents.get("foo")).toEqual({ type: "card" });
    expect(s.tabs.get("default")?.id).toBe("default");
  });

  it("re-assignable scalars accept new values", () => {
    const s = new AethonAgentState(defaultOpts);
    s.currentAgentTabId = "tab-1";
    s.currentProjectCwd = "/home/user/proj";
    s.eventRoutingMode = "extension";
    s.extensionLayout = { components: [] };
    s.frontendReady = true;
    expect(s.currentAgentTabId).toBe("tab-1");
    expect(s.currentProjectCwd).toBe("/home/user/proj");
    expect(s.eventRoutingMode).toBe("extension");
    expect(s.extensionLayout).toEqual({ components: [] });
    expect(s.frontendReady).toBe(true);
  });

  it("tabContext is an AsyncLocalStorage instance", () => {
    const s = new AethonAgentState(defaultOpts);
    expect(s.tabContext.getStore()).toBeUndefined();
    const result = s.tabContext.run("tab-x", () => s.tabContext.getStore());
    expect(result).toBe("tab-x");
  });
});
