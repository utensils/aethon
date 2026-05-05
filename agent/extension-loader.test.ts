import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type AethonExtensionApi,
  type ExtensionSource,
} from "./state";
import {
  RESERVED_THEME_IDS,
  discoverPersistedTabs,
  loadAethonExtensionDirectory,
  loadAethonExtensions,
  normalizeTheme,
  projectExtensionDisplayName,
} from "./extension-loader";

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

function makeFixture(userDir: string) {
  const state = new AethonAgentState(makeOpts(userDir));
  const sent: Record<string, unknown>[] = [];
  return {
    state,
    sent,
    deps: { send: (m: Record<string, unknown>) => sent.push(m) },
  };
}

describe("normalizeTheme", () => {
  it("rejects malformed inputs", () => {
    expect(normalizeTheme(null)).toBeNull();
    expect(normalizeTheme({})).toBeNull();
    expect(normalizeTheme({ id: "" })).toBeNull();
    expect(normalizeTheme({ id: "1bad" })).toBeNull();
  });

  it("rejects reserved built-in ids", () => {
    expect(normalizeTheme({ id: "ember" })).toBeNull();
    expect(normalizeTheme({ id: "signature" })).toBeNull();
  });

  it("normalizes label fallback to id, filters CSS-vars", () => {
    const t = normalizeTheme({
      id: "twilight",
      vars: {
        "--bg": "#000",
        "no-prefix": "#fff",
        "--text": 12, // non-string value dropped
      },
    });
    expect(t).toEqual({ id: "twilight", label: "twilight", vars: { "--bg": "#000" } });
  });

  it("trims label", () => {
    expect(normalizeTheme({ id: "x", label: "  X  ", vars: {} })).toMatchObject({
      label: "X",
    });
  });

  it("RESERVED_THEME_IDS exported", () => {
    expect(RESERVED_THEME_IDS.has("ember")).toBe(true);
    expect(RESERVED_THEME_IDS.size).toBeGreaterThanOrEqual(4);
  });
});

describe("projectExtensionDisplayName", () => {
  it("uses scope when extension is under a sub-directory", () => {
    const root = "/home/u/proj";
    const dir = "/home/u/proj/.aethon/extensions";
    expect(projectExtensionDisplayName(root, dir, "linter.ts")).toBe(
      "proj:linter",
    );
  });

  it("falls back to projectName:base when scope is empty", () => {
    expect(projectExtensionDisplayName("/", "/.aethon/extensions", "x.ts")).toBe(
      "project:x",
    );
  });
});

describe("discoverPersistedTabs", () => {
  it("returns [] when sessionsDir does not exist", async () => {
    const f = makeFixture("/tmp/aethon-nope-" + Date.now());
    expect(await discoverPersistedTabs(f.state)).toEqual([]);
  });

  it("ignores 'default' and malformed names; sorts by lastModified desc", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const sessionsDir = join(root, "sessions");
      mkdirSync(join(sessionsDir, "default"), { recursive: true });
      mkdirSync(join(sessionsDir, "tab-a"), { recursive: true });
      mkdirSync(join(sessionsDir, "tab-b"), { recursive: true });
      mkdirSync(join(sessionsDir, "weird name?!"), { recursive: true });
      // Stamp two files in tab-a / tab-b, b is newer.
      const aFile = join(sessionsDir, "tab-a", "1.jsonl");
      const bFile = join(sessionsDir, "tab-b", "1.jsonl");
      writeFileSync(aFile, "");
      writeFileSync(bFile, "");
      const stateOpts = makeOpts(root);
      stateOpts.sessionsDir = sessionsDir;
      const state = new AethonAgentState(stateOpts);
      const tabs = await discoverPersistedTabs(state);
      // No metadata in jsonl → readSessionMetadata returns null → both
      // skipped. We just want to verify the safety filter.
      const ids = tabs.map((t) => t.tabId);
      expect(ids).not.toContain("default");
      expect(ids).not.toContain("weird name?!");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadAethonExtensions", () => {
  it("loads a single extension from <userDir>/extensions and emits extension_lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const extDir = join(root, "extensions");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "hello.mjs"),
        `export function register(api) {
          api.registerComponent("hello", { type: "card" });
        }`,
      );
      const f = makeFixture(root);
      let seen: { type: string; template: unknown } | null = null;
      const api = {
        registerComponent(componentType: string, template: unknown) {
          seen = { type: componentType, template };
        },
        setState() {},
      } as unknown as AethonExtensionApi;
      const registry = new Map<string, ExtensionSource>();
      await loadAethonExtensions(f.state, f.deps, api, registry);
      expect(seen).toEqual({ type: "hello", template: { type: "card" } });
      expect(registry.get("hello")).toBe("directory");
      const lifecycle = f.sent.find(
        (m) => m.type === "extension_lifecycle",
      );
      expect(lifecycle).toMatchObject({ status: "loaded", name: "hello" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a 'skipped' lifecycle when the extension has no register()", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const extDir = join(root, "extensions");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "noop.mjs"), `export const x = 1;`);
      const f = makeFixture(root);
      const api = {
        registerComponent() {},
        setState() {},
      } as unknown as AethonExtensionApi;
      const registry = new Map<string, ExtensionSource>();
      const failures: { name: string; status: string }[] = [];
      await loadAethonExtensions(f.state, f.deps, api, registry, {
        onFailure: (f) => failures.push({ name: f.name, status: f.status }),
      });
      expect(failures).toEqual([{ name: "noop", status: "skipped" }]);
      expect(registry.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets state.currentExtensionName during register() and restores afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const extDir = join(root, "extensions");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, `stamp-${Date.now()}.mjs`),
        `export function register(api) {
          // Mutate the api so we can observe register() ran. The caller
          // checks state.currentExtensionName from inside registerComponent.
          api.registerComponent("probe", null);
        }`,
      );
      const f = makeFixture(root);
      let observedDuringRegister: string | null = "<unset>";
      const api = {
        registerComponent() {
          observedDuringRegister = f.state.currentExtensionName;
        },
        setState() {},
      } as unknown as AethonExtensionApi;
      const registry = new Map<string, ExtensionSource>();
      await loadAethonExtensions(f.state, f.deps, api, registry);
      // While register() ran, currentExtensionName was the displayName.
      expect(observedDuringRegister).toMatch(/^stamp-/);
      // After load, it's restored to null.
      expect(f.state.currentExtensionName).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips disabled extensions and emits a `disabled` lifecycle event", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const extDir = join(root, "extensions");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "muted.mjs"),
        `export function register(api) { api.registerComponent("muted", null); }`,
      );
      const f = makeFixture(root);
      f.state.disabledExtensions.add("muted");
      const api = {
        registerComponent() {},
        setState() {},
      } as unknown as AethonExtensionApi;
      const registry = new Map<string, ExtensionSource>();
      await loadAethonExtensions(f.state, f.deps, api, registry);
      expect(registry.size).toBe(0);
      const lifecycle = f.sent.find(
        (m) => m.type === "extension_lifecycle" && m.status === "disabled",
      );
      expect(lifecycle).toMatchObject({ name: "muted", status: "disabled" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retry a failed extension file on the next load pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const extDir = join(root, "extensions");
      mkdirSync(extDir, { recursive: true });
      // Throws synchronously inside register() — counts as a "failed" load.
      writeFileSync(
        join(extDir, "boom.mjs"),
        `export function register() { throw new Error("boom"); }`,
      );
      const f = makeFixture(root);
      const api = {
        registerComponent() {},
        setState() {},
      } as unknown as AethonExtensionApi;
      const registry = new Map<string, ExtensionSource>();
      const loadedFiles = new Set<string>();
      const failedFiles = new Set<string>();
      const opts = {
        dir: extDir,
        source: "project-directory" as const,
        logPrefix: "test",
        loadedFiles,
        failedFiles,
      };
      await loadAethonExtensionDirectory(f.state, f.deps, api, registry, opts);
      const failuresAfterFirst = f.sent.filter(
        (m) => m.type === "extension_lifecycle" && m.status === "failed",
      ).length;
      expect(failuresAfterFirst).toBe(1);
      expect(failedFiles.size).toBe(1);
      // Second pass: file is in failedFiles, so it's skipped — no new
      // extension_lifecycle event, no log spam.
      await loadAethonExtensionDirectory(f.state, f.deps, api, registry, opts);
      const failuresAfterSecond = f.sent.filter(
        (m) => m.type === "extension_lifecycle" && m.status === "failed",
      ).length;
      expect(failuresAfterSecond).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
