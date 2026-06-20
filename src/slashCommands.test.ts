import { describe, expect, it } from "vitest";
import {
  buildBuiltinSlashCommands,
  parseSlashCommand,
  type SlashCommandContext,
} from "./slashCommands";

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

  it("/loop without args opens scheduled tasks without creating a default loop", async () => {
    const system: string[] = [];
    let opened = 0;
    let creates = 0;
    const ctx = makeSlashContext({
      appendSystem: (text) => system.push(text),
      openScheduledTasks: () => {
        opened += 1;
      },
      createScheduledTask: async () => {
        creates += 1;
        throw new Error("should not create");
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
      createScheduledTask: async (input) => {
        created.push(input);
        return {
          id: "abcdef123456",
          label: "sync from origin main",
          mode: "loopFixed",
          schedule: { kind: "interval", intervalMs: 300_000, label: "5m" },
          visiblePrompt: "sync from origin main",
        } as never;
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

  it("/tasks delete invokes true deletion instead of cancel", async () => {
    const calls: string[] = [];
    const notifications: string[] = [];
    const ctx = makeSlashContext({
      notify: (input) => notifications.push(input.title),
      listScheduledTasks: async () =>
        [
          {
            id: "abcdef123456",
            label: "old loop",
            status: "cancelled",
          },
        ] as never,
      cancelScheduledTask: async (id) => {
        calls.push(`cancel:${id}`);
        return { id, label: "old loop", status: "cancelled" } as never;
      },
      deleteScheduledTask: async (id) => {
        calls.push(`delete:${id}`);
        return { id, label: "old loop", status: "cancelled" } as never;
      },
    });
    const tasks = buildBuiltinSlashCommands().find((c) => c.name === "tasks")!;

    await tasks.run("delete abcdef12", ctx);

    expect(calls).toEqual(["delete:abcdef123456"]);
    expect(notifications).toEqual(["Task cancelled"]);
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
