import { describe, expect, it } from "vitest";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
} from "./state";
import {
  EXT_STATE_LOG_WINDOW_MS,
  frontendActiveTabId,
  makeCanvasApi,
  setState,
} from "./state-mutation";
import type { RateLimiter } from "./state-limits";

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
  statePayloadHardBytes: 128 * 1024, // smaller hard cap for tests
  statePayloadWarnKb: 64,
  statePayloadHardKb: 128,
};

function makeFixture() {
  const state = new AethonAgentState(baseOpts);
  const sent: Record<string, unknown>[] = [];
  // Always-allow log limiter so tests don't accidentally suppress on dedup.
  const noopLimiter: RateLimiter = {
    shouldLog: () => ({ log: true, suppressed: 0 }),
  };
  return {
    state,
    sent,
    deps: {
      send: (m: Record<string, unknown>) => sent.push(m),
      extStateLogLimiter: noopLimiter,
    },
  };
}

describe("setState", () => {
  it("rejects empty paths", async () => {
    const f = makeFixture();
    expect((await setState(f.state, f.deps, "", 1)).ok).toBe(false);
  });

  it("writes into the global tree for non-mirrored top-level keys", async () => {
    const f = makeFixture();
    await setState(f.state, f.deps, "/sidebar/extras", [{ id: "x" }]);
    expect(f.state.extensionStateTree).toMatchObject({
      sidebar: { extras: [{ id: "x" }] },
    });
    expect(f.state.extensionStateKeys.has("/sidebar/extras")).toBe(true);
    expect(f.sent[0]).toMatchObject({
      type: "state_patch",
      path: "/sidebar/extras",
    });
    // No tabId attribution on a tab-less call.
    expect(f.sent[0].tabId).toBeUndefined();
  });

  it("attributes via explicit sourceTabId and routes mirrored keys per tab", async () => {
    const f = makeFixture();
    await setState(f.state, f.deps, "/canvas", { components: [] }, "tab-x");
    expect(f.state.perTabExtState.get("tab-x")).toMatchObject({
      canvas: { components: [] },
    });
    // Did not pollute the global tree.
    expect(f.state.extensionStateTree).toEqual({});
    expect(f.sent[0]).toMatchObject({
      type: "state_patch",
      tabId: "tab-x",
    });
  });

  it("falls through to currentAgentTabId when no explicit tab is given", async () => {
    const f = makeFixture();
    f.state.currentAgentTabId = "tab-y";
    await setState(f.state, f.deps, "/messages", [{ role: "user" }]);
    expect(f.state.perTabExtState.get("tab-y")).toBeDefined();
  });

  it("rejects payloads larger than statePayloadHardBytes and emits extension_runtime_error", async () => {
    const f = makeFixture();
    f.state.currentExtensionName = "naughty-ext";
    const huge = "x".repeat(200 * 1024); // 200 KB > 128 KB hard cap
    const r = await setState(f.state, f.deps, "/blob", huge);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("128 KB limit");
    const errMsg = f.sent.find(
      (m) => m.type === "extension_runtime_error",
    );
    expect(errMsg).toMatchObject({
      kind: "state-too-large",
      name: "naughty-ext",
    });
    // Did NOT write to extensionStateTree.
    expect(f.state.extensionStateTree).toEqual({});
  });

  it("warns but writes for payloads between warn and hard limits", async () => {
    const f = makeFixture();
    const big = "x".repeat(80 * 1024); // 80 KB > 64 KB warn but < 128 KB hard
    const r = await setState(f.state, f.deps, "/note", big);
    expect(r.ok).toBeDefined();
    // Wrote to the tree.
    expect(
      (f.state.extensionStateTree as { note?: string }).note,
    ).toEqual(big);
  });

  it("records currentExtensionName as path owner for later async writes", async () => {
    const f = makeFixture();
    f.state.currentExtensionName = "my-ext";
    await setState(f.state, f.deps, "/foo", 1);
    expect(f.state.extPathOwners.get("/foo")).toBe("my-ext");
    f.state.currentExtensionName = null;
    // Re-write attributes back to my-ext via extPathOwners.
    const huge = "x".repeat(200 * 1024);
    await setState(f.state, f.deps, "/foo", huge);
    const errMsg = f.sent.find(
      (m) => m.type === "extension_runtime_error",
    );
    expect((errMsg as { name?: string }).name).toBe("my-ext");
  });
});

describe("frontendActiveTabId", () => {
  it("returns undefined when /tabs is not in frontendState", () => {
    const f = makeFixture();
    expect(frontendActiveTabId(f.state)).toBeUndefined();
  });

  it("returns undefined when no tab has active:true", () => {
    const f = makeFixture();
    f.state.frontendState.set("/tabs", [
      { id: "a", active: false },
      { id: "b", active: false },
    ]);
    expect(frontendActiveTabId(f.state)).toBeUndefined();
  });

  it("returns the id of the active tab", () => {
    const f = makeFixture();
    f.state.frontendState.set("/tabs", [
      { id: "a", active: false },
      { id: "b", active: true },
      { id: "c", active: false },
    ]);
    expect(frontendActiveTabId(f.state)).toBe("b");
  });

  it("ignores malformed entries", () => {
    const f = makeFixture();
    f.state.frontendState.set("/tabs", [null, "string", { active: true }, { id: "z", active: true }]);
    expect(frontendActiveTabId(f.state)).toBe("z");
  });
});

describe("makeCanvasApi", () => {
  it("emits a /canvas write attributed to the bound tab", async () => {
    const f = makeFixture();
    const canvas = makeCanvasApi(f.state, f.deps, "tab-x");
    await canvas.emit([{ id: "c1", type: "card" }]);
    expect(f.state.perTabExtState.get("tab-x")).toMatchObject({
      canvas: { components: [{ id: "c1", type: "card" }] },
    });
  });

  it("clear() writes an empty components array", async () => {
    const f = makeFixture();
    const canvas = makeCanvasApi(f.state, f.deps, "tab-x");
    await canvas.emit([{ id: "c1", type: "card" }]);
    await canvas.clear();
    expect(
      (f.state.perTabExtState.get("tab-x") as { canvas?: unknown })?.canvas,
    ).toEqual({ components: [] });
  });
});

it("EXT_STATE_LOG_WINDOW_MS is exported as 60s", () => {
  expect(EXT_STATE_LOG_WINDOW_MS).toBe(60_000);
});
