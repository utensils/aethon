import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBuiltinSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
} from "./slashCommands";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function makeSlashContext(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    appendSystem: () => {},
    notify: () => {},
    clearChat: () => {},
    setTheme: () => {},
    listThemes: () => [],
    setModel: async () => {},
    resetLayout: () => {},
    listExtensions: () => [],
    installExtension: () => Promise.resolve(""),
    listModels: () => [],
    openLogin: () => {},
    listAuthProfiles: () => [],
    useAuthProfile: () => Promise.resolve(),
    setDefaultAuthProfile: () => Promise.resolve(),
    toggleTerminal: () => {},
    toggleSidebar: () => {},
    toggleFilesSidebar: () => {},
    activateLayout: () => false,
    listLayouts: () => [],
    pickProject: () => Promise.resolve(null),
    openProject: () => "",
    setActiveProject: () => false,
    clearProject: () => {},
    removeProject: () => false,
    listProjects: () => [],
    activeProject: () => null,
    reloadAgent: () => Promise.resolve(),
    runNativeCommand: () => Promise.resolve(),
    renameSession: () => Promise.resolve(),
    activeTabId: () => "default",
    ...overrides,
  };
}

function mockApprovedMcpProject(): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "aethon_setup_status") {
      return Promise.resolve({
        root: "/repo",
        agents: { exists: true, path: "/repo/AGENTS.md", managedBlock: true },
        startup: { exists: false, path: "/repo/.aethon/startup.toml" },
        mcpToml: { exists: false, path: "/repo/.aethon/mcp.toml" },
        claudeMcpJson: { exists: true, path: "/repo/.mcp.json" },
      });
    }
    if (command === "mcp_config_status") {
      return Promise.resolve({
        root: "/repo",
        fingerprint: "fingerprint",
        state: "approved",
        required: true,
        approved: true,
        enabled: true,
        projectConfigMode: "require-approval",
        sources: [
          {
            kind: "claude-json",
            relativePath: ".mcp.json",
            path: "/repo/.mcp.json",
          },
        ],
        servers: [
          {
            name: "query",
            sourceKind: "claude-json",
            sourcePath: ".mcp.json",
            transport: "stdio",
            command: "nix",
          },
        ],
      });
    }
    if (command === "aethon_setup_import_mcp_json") {
      return Promise.resolve({ path: "/repo/.aethon/mcp.toml" });
    }
    if (
      command === "aethon_setup_set_host_mcp_policy" ||
      command === "mcp_config_approve"
    ) {
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("parseSlashCommand", () => {
  it("returns null for plain text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  it("returns null for the literal-slash escape `//`", () => {
    expect(parseSlashCommand("//literal")).toBeNull();
  });

  it("parses a command with no args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  it("parses a command with args", () => {
    expect(parseSlashCommand("/theme dark")).toEqual({
      name: "theme",
      args: "dark",
    });
  });

  it("preserves multi-line args (slash commands can span lines)", () => {
    const parsed = parseSlashCommand("/help line1\nline2");
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("help");
    expect(parsed!.args).toBe("line1\nline2");
  });

  it("trims leading whitespace before the slash", () => {
    expect(parseSlashCommand("   /clear")).toEqual({ name: "clear", args: "" });
  });

  it("rejects names that start with a digit", () => {
    expect(parseSlashCommand("/9invalid")).toBeNull();
  });

  it("accepts names with hyphens and underscores", () => {
    expect(parseSlashCommand("/foo-bar_baz")).toEqual({
      name: "foo-bar_baz",
      args: "",
    });
  });

  it("accepts pi skill command names with one colon segment", () => {
    expect(parseSlashCommand("/skill:review diff")).toEqual({
      name: "skill:review",
      args: "diff",
    });
  });

  it("accepts pi duplicate command suffixes", () => {
    expect(parseSlashCommand("/review:1 file.ts")).toEqual({
      name: "review:1",
      args: "file.ts",
    });
  });

  it("normalizes numbered MCP adapter commands to Aethon's local MCP command", () => {
    expect(parseSlashCommand("/mcp:1")).toEqual({
      name: "mcp",
      args: "1",
    });
    expect(parseSlashCommand("/mcp-auth:2 login")).toEqual({
      name: "mcp-auth",
      args: "2 login",
    });
  });
});

describe("buildBuiltinSlashCommands", () => {
  it("returns at least the documented built-ins", () => {
    const names = buildBuiltinSlashCommands().map((c) => c.name);
    for (const expected of [
      "clear",
      "help",
      "theme",
      "model",
      "plan",
      "init",
      "config",
      "mcp",
      "mcp-auth",
      "login",
      "context",
      "session",
      "compact",
      "name",
      "export",
      "reset",
      "terminal",
      "extensions",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("every built-in carries a description", () => {
    for (const cmd of buildBuiltinSlashCommands()) {
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("every built-in has a run() handler", () => {
    for (const cmd of buildBuiltinSlashCommands()) {
      expect(typeof cmd.run).toBe("function");
    }
  });

  it("/plan toggles the active session mode", async () => {
    const notifications: string[] = [];
    const states: boolean[] = [];
    let enabled = false;
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: (input) => notifications.push(input.title),
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      setPlanMode: (next) => {
        enabled = next;
        states.push(next);
      },
      getPlanMode: () => enabled,
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: async () => {},
      setDefaultAuthProfile: async () => {},
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: async () => {},
      runNativeCommand: async () => {},
      renameSession: async () => {},
      activeTabId: () => "tab-1",
    };
    const plan = buildBuiltinSlashCommands().find((c) => c.name === "plan")!;

    await plan.run("", ctx);
    await plan.run("off", ctx);

    expect(states).toEqual([true, false]);
    expect(notifications).toEqual(["Plan mode on", "Implementation mode on"]);
  });

  it("/extensions install invokes the in-app installer", async () => {
    const installed: string[] = [];
    const system: string[] = [];
    const notifications: string[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: (text) => system.push(text),
      notify: (input) => notifications.push(input.title),
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: (spec) => {
        installed.push(spec);
        return Promise.resolve("installed output");
      },
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: () => Promise.resolve(),
      setDefaultAuthProfile: () => Promise.resolve(),
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "project-id",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => Promise.resolve(),
      runNativeCommand: () => Promise.resolve(),
      renameSession: () => Promise.resolve(),
      activeTabId: () => "default",
    };
    const extensions = buildBuiltinSlashCommands().find(
      (c) => c.name === "extensions",
    )!;

    await extensions.run("install github:utensils/aethon-demo-extension", ctx);

    expect(installed).toEqual(["github:utensils/aethon-demo-extension"]);
    expect(notifications).toContain("Installing extension");
    expect(system[0]).toContain("Extension install complete");
    expect(system[0]).toContain("installed output");
  });

  it("/rename forwards to renameSession with the active tab id", async () => {
    const calls: { tabId: string; label: string }[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: () => {},
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: () => Promise.resolve(),
      setDefaultAuthProfile: () => Promise.resolve(),
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => Promise.resolve(),
      runNativeCommand: () => Promise.resolve(),
      renameSession: (tabId, label) => {
        calls.push({ tabId, label });
        return Promise.resolve();
      },
      activeTabId: () => "tab-7",
    };
    const rename = buildBuiltinSlashCommands().find(
      (c) => c.name === "rename",
    )!;
    await rename.run("Refactor pass", ctx);
    expect(calls).toEqual([{ tabId: "tab-7", label: "Refactor pass" }]);
  });

  it("/login opens the account manager and can switch accounts", async () => {
    let opened = 0;
    const calls: string[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: () => {},
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {
        opened += 1;
      },
      listAuthProfiles: () => [],
      useAuthProfile: (id) => {
        calls.push(`use:${id}`);
        return Promise.resolve();
      },
      setDefaultAuthProfile: (id) => {
        calls.push(`default:${id}`);
        return Promise.resolve();
      },
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => Promise.resolve(),
      runNativeCommand: () => Promise.resolve(),
      renameSession: () => Promise.resolve(),
      activeTabId: () => "tab-7",
    };
    const login = buildBuiltinSlashCommands().find((c) => c.name === "login")!;

    await login.run("", ctx);
    await login.run("use claude-work", ctx);
    await login.run("default claude-home", ctx);

    expect(opened).toBe(1);
    expect(calls).toEqual(["use:claude-work", "default:claude-home"]);
  });

  it("/reload calls reloadAgent and toasts", async () => {
    let reloadCalls = 0;
    const titles: string[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: (input) => titles.push(input.title),
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: () => Promise.resolve(),
      setDefaultAuthProfile: () => Promise.resolve(),
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => {
        reloadCalls += 1;
        return Promise.resolve();
      },
      runNativeCommand: () => Promise.resolve(),
      renameSession: () => Promise.resolve(),
      activeTabId: () => null,
    };
    const reload = buildBuiltinSlashCommands().find(
      (c) => c.name === "reload",
    )!;
    expect(reload).toBeDefined();
    await reload.run("", ctx);
    expect(reloadCalls).toBe(1);
    expect(titles).toContain("Reloading agent…");
  });

  it("/mcp lists visible MCP servers", async () => {
    mockApprovedMcpProject();
    const askUser = vi.fn();
    const system: string[] = [];
    const mcp = buildBuiltinSlashCommands().find((c) => c.name === "mcp")!;

    await mcp.run(
      "",
      makeSlashContext({
        activeProjectRoot: () => "/repo",
        appendSystem: (text) => system.push(text),
        askUser,
      }),
    );

    expect(askUser).not.toHaveBeenCalled();
    expect(system).toEqual([
      "## MCP servers\n- `query` (stdio) from `.mcp.json` — nix",
    ]);
  });

  it("/mcp setup opens the guided setup flow after project approval", async () => {
    mockApprovedMcpProject();
    const asked: string[] = [];
    const system: string[] = [];
    const mcp = buildBuiltinSlashCommands().find((c) => c.name === "mcp")!;

    await mcp.run(
      "setup",
      makeSlashContext({
        activeProjectRoot: () => "/repo",
        appendSystem: (text) => system.push(text),
        askUser: (input) => {
          asked.push(input.title ?? "");
          expect(input.prompt).toContain("State: approved");
          expect(input.choices.map((choice) => choice.id)).toContain("status");
          return Promise.resolve({
            questionId: "question-1",
            choiceId: "status",
            label: "Show status",
          });
        },
      }),
    );

    expect(asked).toEqual(["MCP setup"]);
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("## MCP");
    expect(system[0]).toContain("Sources: `.mcp.json`");
  });

  it("/mcp setup creates Aethon MCP config from .mcp.json when selected", async () => {
    mockApprovedMcpProject();
    const system: string[] = [];
    const notifications: string[] = [];
    const mcp = buildBuiltinSlashCommands().find((c) => c.name === "mcp")!;

    await mcp.run(
      "setup",
      makeSlashContext({
        activeProjectRoot: () => "/repo",
        appendSystem: (text) => system.push(text),
        notify: (input) => notifications.push(input.title),
        askUser: (input) => {
          expect(input.choices).toContainEqual(
            expect.objectContaining({
              id: "import",
              label: "Create Aethon MCP config",
            }),
          );
          return Promise.resolve({
            questionId: "question-1",
            choiceId: "import",
            label: "Create Aethon MCP config",
          });
        },
      }),
    );

    expect(invokeMock).toHaveBeenCalledWith("aethon_setup_import_mcp_json", {
      root: "/repo",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "mcp_config_approve",
      expect.objectContaining({ root: "/repo", fingerprint: "fingerprint" }),
    );
    expect(notifications).toContain("MCP imported");
    expect(system[0]).toContain(
      "Created MCP config at `/repo/.aethon/mcp.toml`",
    );
  });

  it("/mcp status prints status without opening the guided setup flow", async () => {
    mockApprovedMcpProject();
    const askUser = vi.fn();
    const system: string[] = [];
    const mcp = buildBuiltinSlashCommands().find((c) => c.name === "mcp")!;

    await mcp.run(
      "status",
      makeSlashContext({
        activeProjectRoot: () => "/repo",
        appendSystem: (text) => system.push(text),
        askUser,
      }),
    );

    expect(askUser).not.toHaveBeenCalled();
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("## MCP");
    expect(system[0]).toContain("State: approved");
  });

  it("/mcp rejects unknown subcommands with the explicit usage", async () => {
    mockApprovedMcpProject();
    const notifications: string[] = [];
    const mcp = buildBuiltinSlashCommands().find((c) => c.name === "mcp")!;

    await mcp.run(
      "wat",
      makeSlashContext({
        activeProjectRoot: () => "/repo",
        notify: (input) =>
          notifications.push(`${input.title}\n${input.message ?? ""}`),
      }),
    );

    expect(notifications).toEqual([
      "Unknown MCP command: wat\nUsage: /mcp [status|setup]",
    ]);
  });

  it("/loop without args opens scheduled tasks without creating a default loop", async () => {
    const system: string[] = [];
    let opened = 0;
    let creates = 0;
    const ctx = makeSlashContext({
      appendSystem: (text) => system.push(text),
      openScheduledTasks: () => {
        opened += 1;
      },
      createScheduledTask: () => {
        creates += 1;
        return Promise.reject(new Error("should not create"));
      },
    });
    const loop = buildBuiltinSlashCommands().find((c) => c.name === "loop")!;

    await loop.run("", ctx);

    expect(opened).toBe(1);
    expect(creates).toBe(0);
    expect(system[0]).toContain("No loop scheduled");
  });

  it("/loop with args confirms the scheduled loop in chat", async () => {
    const system: string[] = [];
    const notifications: string[] = [];
    const created: unknown[] = [];
    const ctx = makeSlashContext({
      appendSystem: (text) => system.push(text),
      notify: (input) => notifications.push(input.title),
      createScheduledTask: (input) => {
        created.push(input);
        return Promise.resolve({
          id: "abcdef123456",
          label: "sync from origin main",
          mode: "loopFixed",
          schedule: { kind: "interval", intervalMs: 300_000, label: "5m" },
          visiblePrompt: "sync from origin main",
        } as never);
      },
    });
    const loop = buildBuiltinSlashCommands().find((c) => c.name === "loop")!;

    await loop.run("5m sync from origin main", ctx);

    expect(created).toEqual([
      {
        mode: "loopFixed",
        schedule: { kind: "interval", intervalMs: 300_000, label: "5m" },
        prompt: "sync from origin main",
      },
    ]);
    expect(notifications).toContain("Loop scheduled");
    expect(system[0]).toContain("Loop scheduled (every 5m)");
    expect(system[0]).toContain("Prompt: sync from origin main");
  });

  it("/loop reuse adopts an existing loop on the active session", async () => {
    const system: string[] = [];
    const notifications: string[] = [];
    const reused: string[] = [];
    const ctx = makeSlashContext({
      appendSystem: (text) => system.push(text),
      notify: (input) => notifications.push(input.title),
      listScheduledTasks: () =>
        Promise.resolve([
          {
            id: "abcdef123456",
            label: "old loop",
            status: "cancelled",
            mode: "loopSelfPaced",
            schedule: { kind: "selfPaced" },
          },
        ] as never),
      reuseScheduledTask: (id) => {
        reused.push(id);
        return Promise.resolve({
          id,
          label: "old loop",
          status: "scheduled",
          mode: "loopSelfPaced",
          schedule: { kind: "selfPaced", nextRunAt: 123 },
        } as never);
      },
      createScheduledTask: () => Promise.reject(new Error("should not create")),
    });
    const loop = buildBuiltinSlashCommands().find((c) => c.name === "loop")!;

    await loop.run("reuse abcdef12", ctx);

    expect(reused).toEqual(["abcdef123456"]);
    expect(notifications).toContain("Loop reused here");
    expect(system[0]).toContain("Loop reused on this session");
  });

  it("/tasks delete invokes true deletion instead of cancel", async () => {
    const calls: string[] = [];
    const notifications: string[] = [];
    const ctx = makeSlashContext({
      notify: (input) => notifications.push(input.title),
      listScheduledTasks: () =>
        Promise.resolve([
          {
            id: "abcdef123456",
            label: "old loop",
            status: "cancelled",
          },
        ] as never),
      cancelScheduledTask: (id) => {
        calls.push(`cancel:${id}`);
        return Promise.resolve({
          id,
          label: "old loop",
          status: "cancelled",
        } as never);
      },
      deleteScheduledTask: (id) => {
        calls.push(`delete:${id}`);
        return Promise.resolve({
          id,
          label: "old loop",
          status: "cancelled",
        } as never);
      },
    });
    const tasks = buildBuiltinSlashCommands().find((c) => c.name === "tasks")!;

    await tasks.run("delete abcdef12", ctx);

    expect(calls).toEqual(["delete:abcdef123456"]);
    expect(notifications).toEqual(["Task deleted"]);
  });

  it("/context routes through the native command bridge", async () => {
    const calls: { name: string; args: string }[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: () => {},
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: () => Promise.resolve(),
      setDefaultAuthProfile: () => Promise.resolve(),
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => Promise.resolve(),
      runNativeCommand: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve();
      },
      renameSession: () => Promise.resolve(),
      activeTabId: () => "default",
    };
    const context = buildBuiltinSlashCommands().find(
      (c) => c.name === "context",
    )!;
    await context.run("", ctx);
    expect(calls).toEqual([{ name: "context", args: "" }]);
  });

  it("/compact routes instructions through the native command bridge", async () => {
    const calls: { name: string; args: string }[] = [];
    const ctx: SlashCommandContext = {
      appendSystem: () => {},
      notify: () => {},
      clearChat: () => {},
      setTheme: () => {},
      listThemes: () => [],
      setModel: async () => {},
      resetLayout: () => {},
      listExtensions: () => [],
      installExtension: () => Promise.resolve(""),
      listModels: () => [],
      openLogin: () => {},
      listAuthProfiles: () => [],
      useAuthProfile: () => Promise.resolve(),
      setDefaultAuthProfile: () => Promise.resolve(),
      toggleTerminal: () => {},
      toggleSidebar: () => {},
      toggleFilesSidebar: () => {},
      activateLayout: () => false,
      listLayouts: () => [],
      pickProject: () => Promise.resolve(null),
      openProject: () => "",
      setActiveProject: () => false,
      clearProject: () => {},
      removeProject: () => false,
      listProjects: () => [],
      activeProject: () => null,
      reloadAgent: () => Promise.resolve(),
      runNativeCommand: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve();
      },
      renameSession: () => Promise.resolve(),
      activeTabId: () => "default",
    };
    const compact = buildBuiltinSlashCommands().find(
      (c) => c.name === "compact",
    )!;
    await compact.run("preserve release checklist", ctx);
    expect(calls).toEqual([
      { name: "compact", args: "preserve release checklist" },
    ]);
  });
});
