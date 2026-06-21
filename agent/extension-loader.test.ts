import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AethonAgentState,
  type AethonAgentStateOptions,
  type AethonExtensionApi,
  type ExtensionSource,
} from "./state";
import { disabledExtensionsFile } from "./disabled-extensions";
import {
  RESERVED_THEME_IDS,
  discoverPersistedTabs,
  loadAethonExtensionDirectory,
  loadAethonExtensionPackages,
  loadAethonExtensions,
  loadProjectAethonExtensions,
  normalizeTheme,
  projectExtensionDisplayName,
  refreshPersistedTabs,
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
    expect(t).toEqual({
      id: "twilight",
      label: "twilight",
      vars: { "--bg": "#000" },
    });
  });

  it("trims label", () => {
    expect(normalizeTheme({ id: "x", label: "  X  ", vars: {} })).toMatchObject(
      {
        label: "X",
      },
    );
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
    expect(
      projectExtensionDisplayName("/", "/.aethon/extensions", "x.ts"),
    ).toBe("project:x");
  });
});

describe("discoverPersistedTabs", () => {
  it("returns [] when sessionsDir does not exist", async () => {
    const f = makeFixture("/tmp/aethon-nope-" + Date.now());
    expect(await discoverPersistedTabs(f.state)).toEqual([]);
  });

  it("allows 'default' and ignores malformed names", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const sessionsDir = join(root, "sessions");
      mkdirSync(join(sessionsDir, "default"), { recursive: true });
      mkdirSync(join(sessionsDir, "tab-a"), { recursive: true });
      mkdirSync(join(sessionsDir, "tab-b"), { recursive: true });
      mkdirSync(join(sessionsDir, "weird name?!"), { recursive: true });
      // Stamp two files in tab-a / tab-b, b is newer.
      const defaultFile = join(sessionsDir, "default", "1.jsonl");
      const aFile = join(sessionsDir, "tab-a", "1.jsonl");
      const bFile = join(sessionsDir, "tab-b", "1.jsonl");
      writeFileSync(
        defaultFile,
        `${JSON.stringify({
          type: "session",
          id: "default",
          cwd: "/tmp/default",
        })}\n`,
      );
      writeFileSync(aFile, "");
      writeFileSync(bFile, "");
      const stateOpts = makeOpts(root);
      stateOpts.sessionsDir = sessionsDir;
      const state = new AethonAgentState(stateOpts);
      const tabs = await discoverPersistedTabs(state);
      const ids = tabs.map((t) => t.tabId);
      expect(ids).toContain("default");
      expect(ids).not.toContain("weird name?!");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshPersistedTabs", () => {
  it("returns [] when sessionsDir does not exist", async () => {
    const f = makeFixture("/tmp/aethon-nope-" + Date.now());
    f.state.discoveredTabs = [
      { tabId: "existing", lastModified: 123, cwd: "/proj" },
    ];

    expect(await refreshPersistedTabs(f.state)).toEqual([]);
  });

  it("preserves existing tabs on non-ENOENT readdir failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-ext-"));
    try {
      const stateOpts = makeOpts(root);
      stateOpts.sessionsDir = join(root, "sessions-as-file");
      writeFileSync(stateOpts.sessionsDir, "not a directory");
      const state = new AethonAgentState(stateOpts);
      const existing = [{ tabId: "existing", lastModified: 123, cwd: "/proj" }];
      state.discoveredTabs = existing;

      expect(await refreshPersistedTabs(state)).toBe(existing);
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
      const lifecycle = f.sent.find((m) => m.type === "extension_lifecycle");
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

describe("loadAethonExtensionPackages", () => {
  it("loads package folders placed directly under ~/.aethon/extensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-pkg-"));
    try {
      const pkgDir = join(root, "extensions", "direct-package");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "direct-package",
          aethon: { entry: "./index.mjs", frontendEntry: "./frontend.js" },
        }),
      );
      writeFileSync(
        join(pkgDir, "index.mjs"),
        `export function register(api) { api.registerTheme({ id: "direct-pkg", vars: { "--bg": "#000" } }); }`,
      );
      writeFileSync(join(pkgDir, "frontend.js"), `// frontend`);
      const f = makeFixture(root);
      const frontendEntries: {
        name: string;
        entryPath: string;
        code: string;
      }[] = [];

      await loadAethonExtensionPackages(
        f.state,
        f.deps,
        {
          registerTheme(theme) {
            f.state.extensionThemes.set(theme.id, theme);
            return Promise.resolve({ ok: true });
          },
        } as unknown as AethonExtensionApi,
        f.state.loadedExtensions,
        { onFrontendEntry: (entry) => frontendEntries.push(entry) },
      );

      expect(f.state.loadedExtensions.get("direct-package")).toBe(
        "extension-package",
      );
      expect(f.state.extensionThemes.has("direct-pkg")).toBe(true);
      expect(frontendEntries).toEqual([
        expect.objectContaining({
          name: "direct-package",
          code: "// frontend",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed direct package manifests as load failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-pkg-"));
    try {
      const pkgDir = join(root, "extensions", "broken-package");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), `{ nope`);
      const f = makeFixture(root);
      const failures: Record<string, unknown>[] = [];

      await loadAethonExtensionPackages(
        f.state,
        f.deps,
        {} as AethonExtensionApi,
        f.state.loadedExtensions,
        { onFailure: (failure) => failures.push(failure) },
      );

      expect(failures).toEqual([
        expect.objectContaining({
          name: "broken-package",
          source: "extension-package",
          status: "failed",
          path: join(pkgDir, "package.json"),
        }),
      ]);
      expect(f.sent).toContainEqual(
        expect.objectContaining({
          type: "extension_lifecycle",
          name: "broken-package",
          source: "extension-package",
          status: "failed",
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadProjectAethonExtensions", () => {
  it("prunes disabled project-extension records whose files were removed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "aethon-proj-"));
    const projectRoot = join(workspace, "mold");
    try {
      const extDir = join(projectRoot, ".aethon", "extensions");
      mkdirSync(join(projectRoot, ".git"), { recursive: true });
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "kept.mjs"),
        `export function register() { throw new Error("should be disabled"); }`,
      );
      mkdirSync(join(extDir, "packaged-extension"), { recursive: true });
      const f = makeFixture(workspace);
      f.state.disabledExtensions.add("mold:kept");
      f.state.disabledExtensions.add("mold:stale");
      f.state.disabledExtensionMeta.set("mold:kept", {
        source: "project-directory",
        projectRoot,
      });
      f.state.disabledExtensionMeta.set("mold:stale", {
        source: "project-directory",
        projectRoot,
      });

      const result = await loadProjectAethonExtensions(
        f.state,
        f.deps,
        projectRoot,
        { registerComponent() {} } as unknown as AethonExtensionApi,
        new Map(),
        new Set(),
        new Set(),
      );

      expect(result.prunedDisabled).toBe(1);
      expect(f.state.disabledExtensions.has("mold:kept")).toBe(true);
      expect(f.state.disabledExtensions.has("mold:stale")).toBe(false);
      expect(f.sent).toContainEqual(
        expect.objectContaining({
          type: "extension_lifecycle",
          name: "mold:kept",
          status: "disabled",
        }),
      );
      expect(
        JSON.parse(readFileSync(disabledExtensionsFile(workspace), "utf8")),
      ).toEqual({
        disabled: [
          {
            name: "mold:kept",
            source: "project-directory",
            projectRoot,
          },
        ],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("prunes legacy project-looking disabled records after scanning that project", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "aethon-proj-"));
    const projectRoot = join(workspace, "mold");
    try {
      const extDir = join(projectRoot, ".aethon", "extensions");
      mkdirSync(join(projectRoot, ".git"), { recursive: true });
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "present.mjs"),
        `export function register() { throw new Error("should be disabled"); }`,
      );
      const f = makeFixture(workspace);
      f.state.disabledExtensions.add("mold:present");
      f.state.disabledExtensions.add("mold:removed");
      f.state.disabledExtensions.add("@mold/package-ui");
      f.state.disabledExtensionMeta.set("@mold/package-ui", {
        source: "extension-package",
      });

      const result = await loadProjectAethonExtensions(
        f.state,
        f.deps,
        projectRoot,
        { registerComponent() {} } as unknown as AethonExtensionApi,
        new Map(),
        new Set(),
        new Set(),
      );

      expect(result.prunedDisabled).toBe(1);
      expect([...f.state.disabledExtensions].sort()).toEqual([
        "@mold/package-ui",
        "mold:present",
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps disabled records for project scopes that were not scanned", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "aethon-proj-"));
    const projectRoot = join(workspace, "mold");
    try {
      const extDir = join(projectRoot, ".aethon", "extensions");
      mkdirSync(join(projectRoot, ".git"), { recursive: true });
      mkdirSync(extDir, { recursive: true });
      const f = makeFixture(workspace);
      f.state.disabledExtensions.add("mold/nested:nested-ext");
      f.state.disabledExtensionMeta.set("mold/nested:nested-ext", {
        source: "project-directory",
        projectRoot,
      });

      const result = await loadProjectAethonExtensions(
        f.state,
        f.deps,
        projectRoot,
        { registerComponent() {} } as unknown as AethonExtensionApi,
        new Map(),
        new Set(),
        new Set(),
      );

      expect(result.prunedDisabled).toBe(0);
      expect(f.state.disabledExtensions.has("mold/nested:nested-ext")).toBe(
        true,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
