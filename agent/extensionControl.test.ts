import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./extension-hot-toggle", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./extension-hot-toggle")>();
  return { ...original, hotReloadExtensions: vi.fn() };
});

import { handleSetExtensionDisabled } from "./extensionControl";
import { hotReloadExtensions } from "./extension-hot-toggle";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type AethonExtensionApi,
} from "./state";

function makeOpts(userDir: string): AethonAgentStateOptions {
  return {
    userDir,
    stateFile: join(userDir, "state.json"),
    sessionsDir: join(userDir, "sessions"),
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
}

function makeFixture() {
  const userDir = mkdtempSync(join(tmpdir(), "aethon-ext-control-"));
  const state = new AethonAgentState(makeOpts(userDir));
  const sent: Record<string, unknown>[] = [];
  const deps = {
    send: (m: Record<string, unknown>) => sent.push(m),
    scheduleStateFileWrite: () => {},
    loadHooks: {},
  };
  const api = {} as AethonExtensionApi;
  return {
    userDir,
    state,
    sent,
    deps,
    api,
    types: () => sent.map((m) => m.type),
    cleanup: () => rmSync(userDir, { recursive: true, force: true }),
  };
}

type Fixture = ReturnType<typeof makeFixture>;

describe("handleSetExtensionDisabled hot path", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
    vi.mocked(hotReloadExtensions).mockReset();
  });

  afterEach(() => {
    delete process.env.AETHON_HOT_EXTENSION_TOGGLE;
    f.cleanup();
  });

  it("hot-applies a directory extension toggle: worker refresh, no respawn", async () => {
    f.state.loadedExtensions.set("my-ext", "directory");
    vi.mocked(hotReloadExtensions).mockResolvedValue("applied");

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "my-ext", disabled: true },
      f.api,
    );

    expect(hotReloadExtensions).toHaveBeenCalledTimes(1);
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "extension_lifecycle",
        name: "my-ext",
        status: "disabled",
        hotApplied: true,
      }),
    );
    expect(f.types()).toContain("worker_refresh_required");
    expect(f.types()).not.toContain("reload_required");
    expect(f.state.disabledExtensions.has("my-ext")).toBe(true);
  });

  it("does not report success when a hot ENABLE's load failed", async () => {
    f.state.disabledExtensions.add("my-ext");
    f.state.disabledExtensionMeta.set("my-ext", { source: "directory" });
    vi.mocked(hotReloadExtensions).mockImplementation((state) => {
      state.loadFailures.set("my-ext", {
        source: "directory",
        status: "failed",
        error: "register() exploded",
      });
      return Promise.resolve("applied" as const);
    });

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "my-ext", disabled: false },
      f.api,
    );

    // No hotApplied success lifecycle, an error toast instead, and the
    // workers still converge on the new disabled list.
    expect(f.sent).not.toContainEqual(
      expect.objectContaining({ hotApplied: true }),
    );
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "notification",
        notification: expect.objectContaining({
          title: expect.stringContaining("failed to load"),
          kind: "error",
        }),
      }),
    );
    expect(f.types()).toContain("worker_refresh_required");
    expect(f.types()).not.toContain("reload_required");
  });

  it("falls back to the respawn when the hot reload fails", async () => {
    f.state.loadedExtensions.set("my-ext", "directory");
    vi.mocked(hotReloadExtensions).mockResolvedValue("fallback");

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "my-ext", disabled: true },
      f.api,
    );

    expect(f.types()).toContain("reload_required");
    expect(f.types()).not.toContain("worker_refresh_required");
  });

  it("takes the respawn path directly for pi extensions", async () => {
    f.state.loadedExtensions.set("pi-thing", "pi-extension");

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "pi-thing", disabled: true },
      f.api,
    );

    expect(hotReloadExtensions).not.toHaveBeenCalled();
    expect(f.types()).toContain("reload_required");
  });

  it("honors the kill-switch env", async () => {
    process.env.AETHON_HOT_EXTENSION_TOGGLE = "0";
    f.state.loadedExtensions.set("my-ext", "directory");

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "my-ext", disabled: true },
      f.api,
    );

    expect(hotReloadExtensions).not.toHaveBeenCalled();
    expect(f.types()).toContain("reload_required");
  });

  it("keeps the respawn path when no extension api is supplied", async () => {
    f.state.loadedExtensions.set("my-ext", "directory");

    await handleSetExtensionDisabled(
      f.state,
      f.deps,
      { send: f.deps.send },
      { type: "set_extension_disabled", name: "my-ext", disabled: true },
    );

    expect(hotReloadExtensions).not.toHaveBeenCalled();
    expect(f.types()).toContain("reload_required");
  });
});
