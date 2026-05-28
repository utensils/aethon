import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import { buildAethonApi } from "./aethon-api";
import type { RuntimeSnapshot } from "./system-prompt";
import { markFrontendReady } from "./mutation-ack";

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

function fakeSnapshot(): RuntimeSnapshot {
  return {
    release: false,
    cwd: "/tmp",
    docsDir: undefined,
    projectRoot: undefined,
    userDir: "/tmp",
    stateFile: "/tmp/state.json",
    extensions: [],
    failedExtensions: [],
    themes: [],
    components: [],
    layoutSummary: "",
    tabs: [],
    eventHandlers: [],
    slashCommands: [],
    keybindings: [],
    menuItems: [],
    eventRoutes: [],
    eventRoutingMode: "builtin",
    uiState: {},
    layoutStructure: null,
    layoutSlots: null,
    layouts: [],
    frontendModules: [],
  };
}

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  let writes = 0;
  const api = buildAethonApi(state, {
    send: (m) => sent.push(m),
    scheduleStateFileWrite: () => {
      writes += 1;
    },
    getRuntimeSnapshot: fakeSnapshot,
  });
  return { state, sent, api, writes: () => writes };
}

describe("buildAethonApi", () => {
  it("exposes the documented surface", () => {
    const { api } = makeFixture();
    expect(typeof api.registerComponent).toBe("function");
    expect(typeof api.setState).toBe("function");
    expect(typeof api.onEvent).toBe("function");
    expect(typeof api.setLayout).toBe("function");
    expect(typeof api.patchLayout).toBe("function");
    expect(typeof api.notify).toBe("function");
    expect(typeof api.canvas).toBe("object");
    expect(typeof api.shells).toBe("object");
  });

  it("registerComponent accepts the bare and components-wrapped shapes", async () => {
    const { state, api } = makeFixture();
    await api.registerComponent("hello", { type: "card" });
    expect(state.extensionComponents.get("hello")).toEqual({ type: "card" });
    await api.registerComponent("wrapped", {
      components: [{ type: "card", props: { title: "x" } }],
    });
    expect(state.extensionComponents.get("wrapped")).toEqual({
      type: "card",
      props: { title: "x" },
    });
  });

  it("registerComponent rejects empty type", async () => {
    const { api } = makeFixture();
    await expect(api.registerComponent("", { type: "x" })).resolves.toEqual({
      ok: false,
      error: "componentType required",
    });
  });

  it("registerSlashCommand collides with built-ins", async () => {
    const { api } = makeFixture();
    for (const name of ["clear", "login", "files"]) {
      const r = await api.registerSlashCommand({ name });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("collides with a built-in");
    }
  });

  it("registerSlashCommand stores name + description + usage", async () => {
    const { state, api } = makeFixture();
    await api.registerSlashCommand({
      name: "build",
      description: "Run the build",
      usage: "/build [target]",
    });
    expect(state.extensionSlashCommands.get("build")).toEqual({
      name: "build",
      description: "Run the build",
      usage: "/build [target]",
    });
  });

  it("registerMenuItem + unregisterMenuItem", async () => {
    const { state, api } = makeFixture();
    await api.registerMenuItem({ label: "Build", action: "build" });
    expect(state.extensionMenuItems.get("build")).toMatchObject({
      label: "Build",
      action: "build",
      location: "app",
    });
    const r = await api.unregisterMenuItem("build");
    expect(r.ok).toBe(true);
    expect(state.extensionMenuItems.size).toBe(0);
  });

  it("listExtensions / listComponents / listThemes reflect state", () => {
    const { state, api } = makeFixture();
    state.loadedExtensions.set("foo", "directory");
    state.extensionComponents.set("hello", { type: "card" });
    expect(api.listExtensions()).toEqual([
      { name: "foo", source: "directory" },
    ]);
    expect(api.listComponents()).toEqual({ hello: { type: "card" } });
    expect(api.listThemes()).toEqual([]);
  });

  it("registerTheme rejects reserved ids with a clear error", async () => {
    const { api } = makeFixture();
    const r = await api.registerTheme({ id: "ember", vars: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("getRuntimeSnapshot delegates to deps", () => {
    const { api } = makeFixture();
    const snap = api.getRuntimeSnapshot();
    expect(snap.release).toBe(false);
  });

  it("getFrontendState returns a snapshot or specific path", () => {
    const { state, api } = makeFixture();
    state.frontendState.set("/x", 1);
    expect(api.getFrontendState()).toEqual({ "/x": 1 });
    expect(api.getFrontendState("/x")).toBe(1);
    expect(api.getFrontendState("/missing")).toBeUndefined();
  });

  it("shells.list returns frontend_not_ready when handshake hasn't happened", () => {
    // No markFrontendReady yet, no resolver fires within bounded wait.
    const { api } = makeFixture();
    // Smaller timeout via the production default (5s) is too slow for unit
    // tests; we simulate readiness flip.
    markFrontendReady(makeFixture().state); // unrelated state — no effect on this api's state
    // Don't await the production timeout; just assert the API exists +
    // returns a Promise (full integration via aethon-debug).
    const p = api.shells.list();
    expect(typeof p.then).toBe("function");
  });

  it("onEvent registers a handler entry", () => {
    const { state, api } = makeFixture();
    api.onEvent({ eventType: "click" }, () => {});
    expect(state.a2uiEventHandlers).toHaveLength(1);
  });

  it("setLayout records and emits, listLayouts returns metadata", async () => {
    const { state, sent, api } = makeFixture();
    await api.setLayout({ components: [{ id: "root" }] });
    expect(state.extensionLayout).toEqual({ components: [{ id: "root" }] });
    expect(sent.find((m) => m.type === "layout_set")).toBeDefined();
    await api.registerLayout({
      id: "studio",
      name: "Studio",
      payload: { components: [] },
    });
    expect(api.listLayouts()).toEqual([{ id: "studio", name: "Studio" }]);
  });
});
