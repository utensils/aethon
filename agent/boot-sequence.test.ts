import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllExtensions } from "./boot-sequence";
import { createBootTrace } from "./boot-trace";
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

/** Fixture: a temp HOME with `~/.aethon`-style userDir + a temp project
 *  (`.git`-marked) with its own `.aethon/extensions/`. HOME is
 *  overridden so pi-extension discovery scans the fixture, not the real
 *  machine. */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), "aethon-boot-seq-"));
  const userDir = join(home, ".aethon");
  const extDir = join(userDir, "extensions");
  const themesDir = join(userDir, "themes");
  const piExtDir = join(home, ".pi", "agent", "extensions");
  const projectDir = join(home, "project");
  const projectExtDir = join(projectDir, ".aethon", "extensions");
  for (const dir of [extDir, themesDir, piExtDir, projectExtDir]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(projectDir, ".git"), { recursive: true });

  const state = new AethonAgentState(makeOpts(userDir));
  const order: string[] = [];
  const reloadSpy = vi.fn(() => {
    order.push("reload");
    return Promise.resolve();
  });
  state.resourceLoader = {
    reload: reloadSpy,
  } as unknown as AethonAgentState["resourceLoader"];

  const sent: Record<string, unknown>[] = [];
  const api = {
    registerComponent(type: string, template: unknown) {
      state.extensionComponents.set(type, template);
      order.push(`component:${type}`);
    },
    registerTheme(theme: unknown) {
      const id = (theme as { id?: string }).id ?? "unknown";
      state.extensionThemes.set(id, theme as never);
      order.push(`theme:${id}`);
      return Promise.resolve({ ok: true });
    },
  } as unknown as AethonExtensionApi;

  return {
    home,
    userDir,
    extDir,
    themesDir,
    piExtDir,
    projectDir,
    projectExtDir,
    state,
    order,
    reloadSpy,
    sent,
    api,
    extDeps: { send: (m: Record<string, unknown>) => sent.push(m) },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

type Fixture = ReturnType<typeof makeFixture>;

async function run(
  f: Fixture,
  overrides: Partial<Parameters<typeof loadAllExtensions>[3]> = {},
) {
  return loadAllExtensions(f.state, f.extDeps, f.api, {
    userDir: f.userDir,
    loadHooks: {},
    onFrontendEntry: () => {},
    ...overrides,
  });
}

describe("loadAllExtensions", () => {
  let f: Fixture;
  const realHome = process.env.HOME;

  beforeEach(() => {
    f = makeFixture();
    process.env.HOME = f.home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    f.cleanup();
  });

  it("reloads the resource loader exactly once, after every loader", async () => {
    writeFileSync(
      join(f.extDir, "user-ext.ts"),
      `export function register(api) { api.registerComponent("user-comp", null); }`,
    );
    writeFileSync(
      join(f.themesDir, "loose.json"),
      JSON.stringify({ id: "loose", vars: { "--bg": "#000" } }),
    );
    writeFileSync(
      join(f.projectExtDir, "proj-ext.ts"),
      `export function register(api) { api.registerComponent("proj-comp", null); }`,
    );

    await run(f, { workerCwd: f.projectDir });

    expect(f.reloadSpy).toHaveBeenCalledTimes(1);
    expect(f.order.filter((o) => o === "reload")).toHaveLength(1);
    expect(f.order[f.order.length - 1]).toBe("reload");
    // Themes follow the register-loaders (later-wins is semantic).
    expect(f.order.indexOf("theme:loose")).toBeGreaterThan(
      f.order.indexOf("component:user-comp"),
    );
    // Project extensions land after everything non-project.
    expect(f.order.indexOf("component:proj-comp")).toBeGreaterThan(
      f.order.indexOf("theme:loose"),
    );
  });

  it("skips disabled extensions without importing them", async () => {
    writeFileSync(
      join(f.extDir, "muted.ts"),
      `export function register(api) { api.registerComponent("muted-comp", null); }`,
    );
    f.state.disabledExtensions.add("muted");

    await run(f, { workerCwd: f.projectDir });

    expect(f.order).not.toContain("component:muted-comp");
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "extension_lifecycle",
        name: "muted",
        status: "disabled",
      }),
    );
  });

  it("pi-discovery records aethon-aware pi extensions but never overwrites loader-registered names", async () => {
    writeFileSync(
      join(f.extDir, "shared-name.ts"),
      `export function register(api) { api.registerComponent("shared", null); }`,
    );
    writeFileSync(
      join(f.piExtDir, "shared-name.ts"),
      `// touches globalThis.aethon`,
    );
    writeFileSync(
      join(f.piExtDir, "pi-only.ts"),
      `// touches globalThis.aethon`,
    );

    await run(f, { workerCwd: f.projectDir });

    // Control: discovery ran against the fixture HOME and found the
    // pi-only file — guards against a vacuously-passing precedence check.
    expect(f.state.loadedExtensions.get("pi-only")).toBe("pi-extension");
    expect(f.state.loadedExtensions.get("shared-name")).toBe("directory");
  });

  it("captures the project baseline between non-project and project loads", async () => {
    writeFileSync(
      join(f.extDir, "user-ext.ts"),
      `export function register(api) { api.registerComponent("user-comp", null); }`,
    );
    writeFileSync(
      join(f.projectExtDir, "proj-ext.ts"),
      `export function register(api) { api.registerComponent("proj-comp", null); }`,
    );

    await run(f, { workerCwd: f.projectDir });

    expect(f.state.projectBaseline?.components.has("user-comp")).toBe(true);
    expect(f.state.projectBaseline?.components.has("proj-comp")).toBe(false);
    expect(f.state.extensionComponents.has("user-comp")).toBe(true);
    expect(f.state.extensionComponents.has("proj-comp")).toBe(true);
  });

  it("workerCwd pins startupCwd and skips the active-project read", async () => {
    const { startupCwd } = await run(f, { workerCwd: f.projectDir });
    expect(startupCwd).toBe(f.projectDir);
    expect(f.state.currentProjectCwd).toBe(f.projectDir);
  });

  it("resolves startupCwd from the persisted active project when not a worker", async () => {
    writeFileSync(
      join(f.userDir, "projects.json"),
      JSON.stringify({
        schemaVersion: 5,
        activeId: "p1",
        projects: [{ id: "p1", path: f.projectDir }],
      }),
    );

    const { startupCwd } = await run(f);
    expect(startupCwd).toBe(f.projectDir);
  });

  it("records trace spans for each phase including the single reload", async () => {
    const trace = createBootTrace();
    await run(f, { workerCwd: f.projectDir, trace });
    const spans = Object.keys(trace.summary());
    expect(spans).toEqual(
      expect.arrayContaining([
        "user-extensions",
        "extension-packages",
        "themes",
        "pi-discovery",
        "project-extensions",
        "resource-reload",
      ]),
    );
    expect(spans).not.toContain("resource-reload-1");
    expect(spans).not.toContain("resource-reload-2");
  });
});
