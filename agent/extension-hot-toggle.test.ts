import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./dispatcherTypes", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dispatcherTypes")>();
  return { ...original, emitGlobalReady: vi.fn(() => Promise.resolve()) };
});

import { loadAllExtensions } from "./boot-sequence";
import {
  canHotToggle,
  hotReloadExtensions,
  resetHotToggleForTest,
} from "./extension-hot-toggle";
import { emitGlobalReady } from "./dispatcherTypes";
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
  const home = mkdtempSync(join(tmpdir(), "aethon-hot-toggle-"));
  const userDir = join(home, ".aethon");
  const extDir = join(userDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });

  const state = new AethonAgentState(makeOpts(userDir));
  state.resourceLoader = {
    reload: vi.fn(() => Promise.resolve()),
  } as unknown as AethonAgentState["resourceLoader"];

  const sent: Record<string, unknown>[] = [];
  const teardownRuns: string[] = [];
  const api = {
    registerComponent(type: string, template: unknown) {
      state.extensionComponents.set(type, template);
    },
    registerTheme(theme: unknown) {
      const id = (theme as { id?: string }).id ?? "unknown";
      state.extensionThemes.set(id, theme as never);
      return Promise.resolve({ ok: true });
    },
    onUnload(fn: () => void) {
      // Mirror the real _onUnload scope routing.
      if (state.currentExtensionLoadScope === "project") {
        state.projectExtensionTeardowns.push(fn);
      } else {
        state.userExtensionTeardowns.push(fn);
      }
    },
  } as unknown as AethonExtensionApi;

  const deps = {
    send: (m: Record<string, unknown>) => sent.push(m),
    scheduleStateFileWrite: () => {},
    loadHooks: {},
  };

  return {
    home,
    userDir,
    extDir,
    state,
    sent,
    teardownRuns,
    api,
    deps,
    load: () =>
      loadAllExtensions(state, { send: deps.send }, api, {
        userDir,
        workerCwd: userDir,
        loadHooks: {},
        onFrontendEntry: () => {},
      }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

type Fixture = ReturnType<typeof makeFixture>;

describe("hot extension toggle", () => {
  let f: Fixture;
  const realHome = process.env.HOME;

  beforeEach(() => {
    f = makeFixture();
    process.env.HOME = f.home;
    resetHotToggleForTest();
    vi.mocked(emitGlobalReady).mockClear();
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    delete process.env.AETHON_HOT_EXTENSION_TOGGLE;
    f.cleanup();
  });

  it("applies a disable in process: teardown runs, registries rebuild, snapshot re-emits", async () => {
    writeFileSync(
      join(f.extDir, "keeper.ts"),
      `export function register(api) { api.registerComponent("keeper-comp", null); }`,
    );
    writeFileSync(
      join(f.extDir, "victim.ts"),
      `export function register(api) {
        api.registerComponent("victim-comp", null);
        api.onUnload(() => { globalThis.__victimTornDown = true; });
      }`,
    );
    await f.load();
    expect(f.state.extensionComponents.has("victim-comp")).toBe(true);
    expect(f.state.loadedExtensions.get("victim")).toBe("directory");

    f.state.disabledExtensions.add("victim");
    f.sent.length = 0;
    const outcome = await hotReloadExtensions(f.state, f.deps, f.api);

    expect(outcome).toBe("applied");
    expect(
      (globalThis as { __victimTornDown?: boolean }).__victimTornDown,
    ).toBe(true);
    expect(f.state.extensionComponents.has("victim-comp")).toBe(false);
    expect(f.state.extensionComponents.has("keeper-comp")).toBe(true);
    expect(f.state.loadedExtensions.has("victim")).toBe(false);
    expect(f.state.loadedExtensions.get("keeper")).toBe("directory");
    // Wholesale registry snapshot re-emitted, then a fresh ready.
    const types = f.sent.map((m) => m.type);
    expect(types).toContain("extension_components");
    expect(types).toContain("extension_themes");
    expect(emitGlobalReady).toHaveBeenCalledTimes(1);
    // The disabled skip event surfaced during the reload pass.
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "extension_lifecycle",
        name: "victim",
        status: "disabled",
      }),
    );
    delete (globalThis as { __victimTornDown?: boolean }).__victimTornDown;
  });

  it("applies an enable in process: previously-skipped extension registers", async () => {
    writeFileSync(
      join(f.extDir, "muted.ts"),
      `export function register(api) { api.registerComponent("muted-comp", null); }`,
    );
    f.state.disabledExtensions.add("muted");
    await f.load();
    expect(f.state.extensionComponents.has("muted-comp")).toBe(false);

    f.state.disabledExtensions.delete("muted");
    const outcome = await hotReloadExtensions(f.state, f.deps, f.api);
    expect(outcome).toBe("applied");
    expect(f.state.extensionComponents.has("muted-comp")).toBe(true);
    expect(f.state.loadedExtensions.get("muted")).toBe("directory");
  });

  it("falls back when the reload pass fails", async () => {
    (
      f.state.resourceLoader.reload as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    const outcome = await hotReloadExtensions(f.state, f.deps, f.api);
    expect(outcome).toBe("fallback");
    // The latch must release so a later toggle can retry.
    expect(canHotToggle(f.state, "directory")).toEqual({ ok: true });
  });

  it("refuses pi extensions, the kill-switch, and concurrent reloads", async () => {
    expect(canHotToggle(f.state, "pi-extension").ok).toBe(false);

    process.env.AETHON_HOT_EXTENSION_TOGGLE = "0";
    expect(canHotToggle(f.state, "directory").ok).toBe(false);
    delete process.env.AETHON_HOT_EXTENSION_TOGGLE;

    let resolveReload: (() => void) | null = null;
    (
      f.state.resourceLoader.reload as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve;
        }),
    );
    const inFlight = hotReloadExtensions(f.state, f.deps, f.api);
    // The latch flips synchronously, well before the reload runs.
    expect(canHotToggle(f.state, "directory").ok).toBe(false);
    // Wait for the load pass to reach the (held-open) resource reload,
    // then let it finish.
    await vi.waitFor(() => {
      expect(resolveReload).not.toBeNull();
    });
    resolveReload?.();
    await inFlight;
    expect(canHotToggle(f.state, "directory").ok).toBe(true);
  });
});
