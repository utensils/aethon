import { describe, expect, it } from "vitest";
import {
  buildRuntimeSection,
  buildSubagentsSection,
  type RuntimeSnapshot,
} from "./system-prompt";
import { DEFAULT_AETHON_PROMPT } from "./system-prompt/prompt-template";

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
    subagents: [],
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
    highlightGrammars: [],
    nativeWindows: [],
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
            name: "git-workspace-manager",
            source: "directory",
            status: "failed",
            error:
              'This assignment will throw because "entries" is a constant.',
            path: "/Users/me/.aethon/extensions/git-workspace-manager.ts",
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
    expect(out).toContain("`git-workspace-manager` (directory, failed)");
    expect(out).toContain(
      "/Users/me/.aethon/extensions/git-workspace-manager.ts",
    );
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

  it("labels the host dir and defers to the per-turn Working context section", () => {
    const out = buildRuntimeSection(snapshot({ cwd: "/launch/dir" }));
    expect(out).toContain("Agent host dir: `/launch/dir`");
    expect(out).toContain("Working context");
    // The old bare `cwd=...` phrasing is gone — it misled the model into
    // treating the launch dir as the working dir.
    expect(out).not.toContain("cwd=`/launch/dir`");
  });

  it("annotates open tabs with their cwd when present", () => {
    const out = buildRuntimeSection(
      snapshot({
        tabs: [
          {
            id: "default",
            model: "anthropic/x",
            messageCount: 2,
            cwd: "/repo/a",
          },
          { id: "t2", model: "", messageCount: 0 },
        ],
      }),
    );
    expect(out).toContain("cwd `/repo/a`");
    expect(out).toContain("`t2` — model `(none)`, 0 messages");
  });

  it("lists available frontend model ids from the mirrored sidebar state", () => {
    const out = buildRuntimeSection(
      snapshot({
        uiState: {
          "/sidebar/models": [
            { id: "openai-codex/gpt-5.5", label: "GPT-5.5" },
            { id: "github-copilot/gpt-5.5", label: "Copilot: GPT-5.5" },
          ],
        },
      }),
    );
    expect(out).toContain("Available model ids");
    expect(out).toContain("`openai-codex/gpt-5.5` — GPT-5.5");
    expect(out).toContain("bare names like `gpt-5.5` are invalid");
  });

  it("lists open native canvas windows and window-scoped handlers", () => {
    const out = buildRuntimeSection(
      snapshot({
        nativeWindows: [
          {
            id: "Workpad",
            label: "aethon-canvas-Workpad",
            kind: "canvas",
            title: "Workpad",
            tabId: "default",
            componentCount: 2,
          },
        ],
        eventHandlers: [{ windowId: "Workpad", eventType: "click" }],
      }),
    );
    expect(out).toContain("Open native A2UI canvas windows");
    expect(out).toContain("`Workpad`");
    expect(out).toContain("windowId=Workpad");
  });
});

describe("DEFAULT_AETHON_PROMPT", () => {
  it("instructs the agent to title the tab and keep transcript output compact", () => {
    expect(DEFAULT_AETHON_PROMPT).toContain("setSessionTabTitle");
    expect(DEFAULT_AETHON_PROMPT).toContain("brief and descriptive");
    expect(DEFAULT_AETHON_PROMPT).toContain("first generated title is sticky");
    expect(DEFAULT_AETHON_PROMPT).toContain("force: true");
    expect(DEFAULT_AETHON_PROMPT).toContain("Codex Desktop style");
    expect(DEFAULT_AETHON_PROMPT).toContain("meaningful phase changes");
    expect(DEFAULT_AETHON_PROMPT).toContain("Do not mirror routine");
    expect(DEFAULT_AETHON_PROMPT).toContain(
      "one short orientation paragraph per phase",
    );
    expect(DEFAULT_AETHON_PROMPT).toContain(
      "let the tool cards form the activity trail",
    );
    expect(DEFAULT_AETHON_PROMPT).toContain("tool cards carry diffs");
    expect(DEFAULT_AETHON_PROMPT).toContain("Final replies should be compact");
    expect(DEFAULT_AETHON_PROMPT).toContain(
      'Do not end with a generic "if you want"',
    );
    expect(DEFAULT_AETHON_PROMPT).not.toContain(
      "Always inform the user as to what you are doing as you do it",
    );
  });
});

describe("buildSubagentsSection", () => {
  it("returns empty when there are no subagents", () => {
    expect(buildSubagentsSection([])).toBe("");
  });

  it("lists subagents with model, surface, and delegation guidance", () => {
    const out = buildSubagentsSection([
      {
        name: "reviewer",
        description: "Reviews diffs",
        model: "ollama/llama3.3",
        surface: "inline",
      },
      { name: "builder", description: "Builds features", surface: "tab" },
    ]);
    expect(out).toContain("Available subagents");
    expect(out).toContain("`task`");
    expect(out).toContain("`task_batch`");
    expect(out).toContain("@<name>");
    expect(out).toContain("`reviewer`");
    expect(out).toContain("ollama/llama3.3");
    expect(out).toContain("Reviews diffs");
    expect(out).toContain("opens its own tab");
  });

  it("advertises batch handoff for leading mentions and partial delegation for non-leading mentions", () => {
    const out = buildSubagentsSection([
      { name: "reviewer", description: "Reviews diffs", surface: "inline" },
    ]);
    expect(out).toContain("Multiple leading mentions");
    expect(out).toContain('surface: "inline"');
    expect(out).toContain('surface: "background"');
    expect(out).toContain("Non-leading mentions");
  });

  it("is not rendered by buildRuntimeSection (advertisement is per-turn)", () => {
    expect(buildRuntimeSection(snapshot())).not.toContain(
      "Available subagents",
    );
  });
});
