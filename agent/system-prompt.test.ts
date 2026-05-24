import { describe, expect, it } from "vitest";
import { buildRuntimeSection, type RuntimeSnapshot } from "./system-prompt";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    release: false,
    cwd: "/tmp",
    docsDir: undefined,
    projectRoot: undefined,
    userDir: "/tmp/.aethon",
    stateFile: "/tmp/.aethon/state.json",
    extensions: [],
    failedExtensions: [],
    disabledExtensions: [],
    themes: [],
    components: [],
    layoutSummary: "(none)",
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
    ...overrides,
  };
}

describe("buildRuntimeSection failedExtensions", () => {
  it("renders nothing for the failed-extensions block when empty", () => {
    const out = buildRuntimeSection(snapshot());
    expect(out).not.toContain("did NOT load");
    expect(out).toContain("Loaded extensions: none.");
  });

  it("renders failures with name, source, status, error, and path", () => {
    const out = buildRuntimeSection(
      snapshot({
        failedExtensions: [
          {
            name: "git-worktree-manager",
            source: "directory",
            status: "failed",
            error: "This assignment will throw because \"entries\" is a constant.",
            path: "/Users/me/.aethon/extensions/git-worktree-manager.ts",
          },
          {
            name: "no-register",
            source: "extension-package",
            status: "skipped",
            error: "no register() export",
          },
        ],
      }),
    );
    expect(out).toContain("Extensions that did NOT load");
    expect(out).toContain("`git-worktree-manager` (directory, failed)");
    expect(out).toContain("/Users/me/.aethon/extensions/git-worktree-manager.ts");
    expect(out).toContain("entries");
    expect(out).toContain("`no-register` (extension-package, skipped)");
    expect(out).toContain("no register() export");
  });

  it("shows source guard status when projectRoot is set", () => {
    const out = buildRuntimeSection(
      snapshot({ projectRoot: "/Users/dev/Projects/aethon" }),
    );
    expect(out).toContain("Source guard: active");
    expect(out).toContain("{src,src-tauri,agent}/");
    expect(out).not.toContain("Aethon source:");
  });

  it("omits source guard line when projectRoot is undefined", () => {
    const out = buildRuntimeSection(snapshot());
    expect(out).not.toContain("Source guard");
  });

  it("does not crash on a snapshot missing failedExtensions (older shape)", () => {
    const stale: Partial<RuntimeSnapshot> = snapshot();
    delete stale.failedExtensions;
    expect(() => buildRuntimeSection(stale as RuntimeSnapshot)).not.toThrow();
  });
});
