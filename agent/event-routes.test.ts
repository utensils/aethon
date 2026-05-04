import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  listEventRoutes,
  onEvent,
  registerEventRoute,
  setEventRoutingMode,
  unregisterEventRoute,
} from "./event-routes";

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
  let writes = 0;
  return {
    state,
    sent,
    deps: {
      send: (m: Record<string, unknown>) => sent.push(m),
      scheduleStateFileWrite: () => {
        writes += 1;
      },
    },
    writes: () => writes,
  };
}

describe("onEvent", () => {
  it("appends a handler entry and dedupes by (match + fn body)", () => {
    const f = makeFixture();
    const h = () => {};
    onEvent(f.state, f.deps, { eventType: "click" }, h);
    onEvent(f.state, f.deps, { eventType: "click" }, h);
    expect(f.state.a2uiEventHandlers).toHaveLength(1);
    expect(f.state.registeredHandlerKeys.size).toBe(1);
  });

  it("ignores non-function handlers", () => {
    const f = makeFixture();
    onEvent(
      f.state,
      f.deps,
      { eventType: "click" },
      "not-a-fn" as unknown as () => void,
    );
    expect(f.state.a2uiEventHandlers).toHaveLength(0);
  });

  it("schedules a state file write on register", () => {
    const f = makeFixture();
    onEvent(f.state, f.deps, { eventType: "click" }, () => {});
    expect(f.writes()).toBe(1);
  });
});

describe("registerEventRoute", () => {
  it("rejects empty routes (no componentId AND no eventType)", async () => {
    const f = makeFixture();
    const result = await registerEventRoute(f.state, f.deps, {});
    expect(result.ok).toBe(false);
    expect(f.sent[0]).toMatchObject({ type: "notice" });
  });

  it("registers a route by componentId only", async () => {
    const f = makeFixture();
    await registerEventRoute(f.state, f.deps, { componentId: "btn-1" });
    expect(f.state.extensionEventRoutes.get("btn-1:*")).toEqual({
      componentId: "btn-1",
    });
    expect(f.sent[0]).toMatchObject({
      type: "extension_event_routes",
      mode: "builtin",
      routes: [{ componentId: "btn-1" }],
    });
  });

  it("registers a route by eventType only", async () => {
    const f = makeFixture();
    await registerEventRoute(f.state, f.deps, { eventType: "click" });
    expect(f.state.extensionEventRoutes.get("*:click")).toEqual({
      eventType: "click",
    });
  });

  it("registers a route by both", async () => {
    const f = makeFixture();
    await registerEventRoute(f.state, f.deps, {
      componentId: "btn-1",
      eventType: "click",
    });
    expect(f.state.extensionEventRoutes.get("btn-1:click")).toEqual({
      componentId: "btn-1",
      eventType: "click",
    });
  });
});

describe("unregisterEventRoute", () => {
  it("returns 'no such route' when never registered", async () => {
    const f = makeFixture();
    await expect(
      unregisterEventRoute(f.state, f.deps, { componentId: "x" }),
    ).resolves.toEqual({ ok: false, error: "no such route" });
  });

  it("removes a previously registered route and emits the new list", async () => {
    const f = makeFixture();
    await registerEventRoute(f.state, f.deps, { componentId: "a" });
    await registerEventRoute(f.state, f.deps, { componentId: "b" });
    f.sent.length = 0;
    const result = await unregisterEventRoute(f.state, f.deps, {
      componentId: "a",
    });
    expect(result.ok).toBe(true);
    expect(f.sent[0]).toMatchObject({
      type: "extension_event_routes",
      routes: [{ componentId: "b" }],
    });
  });
});

describe("setEventRoutingMode", () => {
  it("rejects unknown modes", async () => {
    const f = makeFixture();
    const result = await setEventRoutingMode(f.state, f.deps, "wrong");
    expect(result.ok).toBe(false);
    expect(f.state.eventRoutingMode).toBe("builtin");
  });

  it("flips state and re-emits the routes list with the new mode", async () => {
    const f = makeFixture();
    await registerEventRoute(f.state, f.deps, { componentId: "btn" });
    f.sent.length = 0;
    await setEventRoutingMode(f.state, f.deps, "extension");
    expect(f.state.eventRoutingMode).toBe("extension");
    expect(f.sent[0]).toMatchObject({
      type: "extension_event_routes",
      mode: "extension",
      routes: [{ componentId: "btn" }],
    });
  });
});

describe("listEventRoutes", () => {
  it("returns the route list as an array", async () => {
    const f = makeFixture();
    expect(listEventRoutes(f.state)).toEqual([]);
    await registerEventRoute(f.state, f.deps, { componentId: "a" });
    await registerEventRoute(f.state, f.deps, { eventType: "click" });
    expect(listEventRoutes(f.state)).toEqual([
      { componentId: "a" },
      { eventType: "click" },
    ]);
  });
});
