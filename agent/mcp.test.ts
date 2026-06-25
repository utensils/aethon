import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  approveAethonMcpProjectConfig,
  buildAethonMcpExtension,
  readLimitedText,
  resolveAethonMcpConfig,
} from "./mcp";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "aethon-mcp-test-"));
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("resolveAethonMcpConfig", () => {
  it("maps host TOML to the adapter proxy config", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
tool_prefix = "srv"
idle_timeout_minutes = 9
auto_auth = true

[mcp.servers.context7]
command = "npx"
args = ["-y", "@context7/mcp"]
env = { CONTEXT7_API_KEY = "$CONTEXT7_API_KEY" }
lifecycle = "persistent"
direct_tools = true
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.enabled).toBe(true);
    expect(resolved.config.imports).toEqual([]);
    expect(resolved.config.settings).toMatchObject({
      toolPrefix: "srv",
      idleTimeout: 9,
      autoAuth: true,
    });
    expect(resolved.config.mcpServers.context7).toEqual({
      command: "npx",
      args: ["-y", "@context7/mcp"],
      env: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY" },
      lifecycle: "keep-alive",
    });
    expect(resolved.config.mcpServers.context7).not.toHaveProperty(
      "directTools",
    );
  });

  it("withholds project configs until their current fingerprint is approved", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp.servers.host]
url = "https://host.example/mcp"
`,
    );
    write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          projectJson: {
            command: "node",
            args: ["server.js"],
            directTools: true,
          },
        },
      }),
    );
    write(
      join(project, ".aethon/mcp.toml"),
      `
[mcp.servers.projectToml]
command = "bun"
args = ["run", "mcp.ts"]
`,
    );

    const before = resolveAethonMcpConfig({ userDir, cwd: project });
    expect(before.projectApproval.required).toBe(true);
    expect(before.projectApproval.approved).toBe(false);
    expect(Object.keys(before.config.mcpServers)).toEqual(["host"]);

    approveAethonMcpProjectConfig(userDir, project);
    const after = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(after.projectApproval.approved).toBe(true);
    expect(Object.keys(after.config.mcpServers)).toEqual([
      "host",
      "projectJson",
      "projectToml",
    ]);
    expect(after.config.mcpServers.projectJson).toEqual({
      command: "node",
      args: ["server.js"],
      cwd: after.projectApproval.root,
    });
    expect(after.config.mcpServers.projectToml).toEqual({
      command: "bun",
      args: ["run", "mcp.ts"],
      cwd: after.projectApproval.root,
    });
    expect(after.config.mcpServers.projectJson).not.toHaveProperty(
      "directTools",
    );

    write(
      join(project, ".aethon/mcp.toml"),
      `
[mcp.servers.changed]
command = "bun"
`,
    );
    const changed = resolveAethonMcpConfig({ userDir, cwd: project });
    expect(changed.projectApproval.approved).toBe(false);
    expect(Object.keys(changed.config.mcpServers)).toEqual(["host"]);
  });

  it("does not bootstrap host MCP config for existing project .mcp.json", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alreadyThere: { command: "node", args: ["mcp-server.js"] },
        },
      }),
    );

    const resolved = resolveAethonMcpConfig({
      userDir,
      cwd: project,
      write: true,
    });

    expect(existsSync(join(userDir, "config.toml"))).toBe(false);
    expect(resolved.projectApproval.required).toBe(true);
    expect(resolved.projectApproval.approved).toBe(false);
    expect(resolved.projectApproval.mode).toBe("require-approval");
    expect(resolved.config.mcpServers.alreadyThere).toBeUndefined();
  });

  it("does not create host MCP config when a project has no MCP files", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });

    resolveAethonMcpConfig({ userDir, cwd: project, write: true });

    expect(existsSync(join(userDir, "config.toml"))).toBe(false);
  });

  it("gives project Aethon TOML precedence over compatibility JSON", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
`,
    );
    write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          duplicate: { command: "node", args: ["json.js"] },
        },
      }),
    );
    write(
      join(project, ".aethon/mcp.toml"),
      `
[mcp.servers.duplicate]
command = "bun"
args = ["toml.ts"]
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.projectApproval.required).toBe(true);
    expect(resolved.projectApproval.approved).toBe(true);
    expect(resolved.config.mcpServers.duplicate).toEqual({
      command: "bun",
      args: ["toml.ts"],
      cwd: resolved.projectApproval.root,
    });
  });

  it("resolves explicit relative project server cwd from the project root", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
`,
    );
    write(
      join(project, ".aethon/mcp.toml"),
      `
[mcp.servers.local]
command = "node"
args = ["server.js"]
cwd = "tools/mcp"
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.config.mcpServers.local?.cwd).toBe(
      join(resolved.projectApproval.root, "tools/mcp"),
    );
  });

  it("expands project-relative imports before writing adapter config", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
imports = ["vscode"]
`,
    );
    write(
      join(project, ".vscode/mcp.json"),
      JSON.stringify({
        "mcp-servers": {
          workspace: { command: "node", args: ["workspace-mcp.js"] },
        },
      }),
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.config.imports).toEqual([]);
    expect(resolved.config.mcpServers.workspace).toEqual({
      command: "node",
      args: ["workspace-mcp.js"],
      cwd: resolved.projectApproval.root,
    });
  });

  it("expands relative project imports before writing adapter config", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
imports = ["./tools/mcp.toml"]
`,
    );
    write(
      join(project, "tools/mcp.toml"),
      `
[mcp.servers.local]
command = "node"
args = ["tools/server.js"]
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.config.imports).toEqual([]);
    expect(resolved.config.mcpServers.local).toEqual({
      command: "node",
      args: ["tools/server.js"],
      cwd: resolved.projectApproval.root,
    });
  });

  it("skips symlinked project MCP files that escape the project root", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
`,
    );
    write(
      join(root, "outside.json"),
      JSON.stringify({ mcpServers: { escaped: { command: "node" } } }),
    );
    symlinkSync(join(root, "outside.json"), join(project, ".mcp.json"));

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.projectApproval.sources).toEqual([]);
    expect(resolved.config.mcpServers.escaped).toBeUndefined();
  });

  it("requires approval before expanding host-requested project imports", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
imports = ["vscode"]
`,
    );
    write(
      join(project, ".vscode/mcp.json"),
      JSON.stringify({
        mcpServers: {
          workspace: { command: "node", args: ["workspace-mcp.js"] },
        },
      }),
    );

    const before = resolveAethonMcpConfig({ userDir, cwd: project });
    expect(before.projectApproval.required).toBe(true);
    expect(before.projectApproval.approved).toBe(false);
    expect(before.projectApproval.sources).toEqual([".vscode/mcp.json"]);
    expect(before.config.mcpServers.workspace).toBeUndefined();
    expect(before.config.imports).toEqual([]);

    approveAethonMcpProjectConfig(userDir, project);
    const after = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(after.projectApproval.approved).toBe(true);
    expect(after.config.mcpServers.workspace).toEqual({
      command: "node",
      args: ["workspace-mcp.js"],
      cwd: after.projectApproval.root,
    });
  });

  it("does not expand host-requested project imports when project configs are disabled", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "never"
imports = ["vscode"]
`,
    );
    write(
      join(project, ".vscode/mcp.json"),
      JSON.stringify({
        mcpServers: {
          workspace: { command: "node", args: ["workspace-mcp.js"] },
        },
      }),
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.projectApproval.required).toBe(false);
    expect(resolved.projectApproval.sources).toEqual([".vscode/mcp.json"]);
    expect(resolved.config.mcpServers.workspace).toBeUndefined();
    expect(resolved.config.imports).toEqual([]);
  });

  it("invalidates project approval when an imported project MCP file changes", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(project, ".aethon/mcp.toml"),
      `
[mcp]
imports = ["vscode"]
`,
    );
    write(
      join(project, ".vscode/mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "node" } } }),
    );

    const approved = approveAethonMcpProjectConfig(userDir, project);
    expect(approved.sources).toEqual([".aethon/mcp.toml", ".vscode/mcp.json"]);
    expect(
      resolveAethonMcpConfig({ userDir, cwd: project }).projectApproval
        .approved,
    ).toBe(true);

    write(
      join(project, ".vscode/mcp.json"),
      JSON.stringify({ mcpServers: { beta: { command: "node" } } }),
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.projectApproval.approved).toBe(false);
    expect(resolved.projectApproval.sources).toEqual([
      ".aethon/mcp.toml",
      ".vscode/mcp.json",
    ]);
  });

  it("maps Aethon lifecycle names to adapter lifecycle names", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp.servers.sessionServer]
command = "node"
lifecycle = "session"

[mcp.servers.persistentServer]
command = "node"
lifecycle = "persistent"
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.config.mcpServers.sessionServer?.lifecycle).toBe("eager");
    expect(resolved.config.mcpServers.persistentServer?.lifecycle).toBe(
      "keep-alive",
    );
  });

  it("writes the generated adapter config when requested", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp.servers.host]
url = "https://host.example/mcp"
`,
    );

    const resolved = resolveAethonMcpConfig({
      userDir,
      cwd: project,
      write: true,
    });
    const generated = JSON.parse(readFileSync(resolved.generatedPath, "utf8"));

    expect(generated).toEqual(resolved.config);
    expect(resolved.adapterCwd).toContain(join(userDir, "mcp", "adapter-cwd"));
    expect(resolved.generatedPath).toMatch(/\.json$/);
  });

  it("reads only the capped prefix of oversized config files", () => {
    const root = tempRoot();
    const path = join(root, ".mcp.json");
    write(path, `${"a".repeat(300 * 1024)}tail`);

    const text = readLimitedText(path);

    expect(text).toHaveLength(256 * 1024);
    expect(text).not.toContain("tail");
  });

  it("skips project MCP paths that are not readable files", () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(join(project, ".mcp.json"), { recursive: true });

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.projectApproval.sources).toEqual([]);
    expect(resolved.projectApproval.required).toBe(false);
  });

  it("writes generated adapter config before pi adapter install completes", async () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
enabled = true
project_configs = "require-approval"
`,
    );
    write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          query: { command: "node", args: ["query-mcp.js"] },
        },
      }),
    );
    approveAethonMcpProjectConfig(userDir, project);

    const previousArgv = process.argv.slice();
    const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
    const registered = {
      flags: [] as string[],
      tools: [] as string[],
      commands: [] as string[],
    };
    try {
      await buildAethonMcpExtension({ userDir, cwd: project })({
        registerFlag: (name: string) => {
          registered.flags.push(name);
        },
        registerTool: (tool: { name: string }) => {
          registered.tools.push(tool.name);
        },
        registerCommand: (name: string) => {
          registered.commands.push(name);
        },
        getAllTools: () => [],
        getFlag: () => undefined,
        on: () => {},
      });
    } finally {
      process.argv.splice(0, process.argv.length, ...previousArgv);
      if (previousDirectTools === undefined)
        delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = previousDirectTools;
    }

    expect(
      JSON.parse(readFileSync(resolvedGeneratedPath(userDir, project), "utf8"))
        .mcpServers.query,
    ).toEqual({
      command: "node",
      args: ["query-mcp.js"],
      cwd: realpathSync(resolve(project)),
    });
    expect(registered.flags).toContain("mcp-config");
    expect(registered.tools).toContain("mcp");
    expect(registered.commands).toEqual(
      expect.arrayContaining(["mcp", "mcp-auth"]),
    );
    expect(process.argv).toEqual(previousArgv);
    expect(process.env.MCP_DIRECT_TOOLS).toBe(previousDirectTools);
  });

  it("refreshes the pi adapter config for the executing session cwd", async () => {
    const root = tempRoot();
    const userDir = join(root, "user");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    write(
      join(userDir, "config.toml"),
      `
[mcp]
project_configs = "auto-load"
`,
    );
    write(
      join(projectA, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "node" } } }),
    );
    write(
      join(projectB, ".mcp.json"),
      JSON.stringify({ mcpServers: { beta: { command: "node" } } }),
    );

    const tools: Record<string, Record<string, unknown>> = {};
    await buildAethonMcpExtension({ userDir, cwd: projectA })({
      registerFlag: () => {},
      registerTool: (tool: { name: string } & Record<string, unknown>) => {
        tools[tool.name] = tool;
      },
      registerCommand: () => {},
      getAllTools: () => [],
      getFlag: () => undefined,
      on: () => {},
    });

    const execute = tools.mcp.execute as (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => Promise<unknown>;

    await execute(
      "call-a",
      {},
      undefined,
      undefined,
      fakeExtensionContext(projectA),
    );
    expect(
      Object.keys(
        JSON.parse(
          readFileSync(resolvedGeneratedPath(userDir, projectA), "utf8"),
        ).mcpServers,
      ),
    ).toEqual(["alpha"]);

    await execute(
      "call-b",
      {},
      undefined,
      undefined,
      fakeExtensionContext(projectB),
    );
    expect(
      Object.keys(
        JSON.parse(
          readFileSync(resolvedGeneratedPath(userDir, projectB), "utf8"),
        ).mcpServers,
      ),
    ).toEqual(["beta"]);

    await execute(
      "call-a2",
      {},
      undefined,
      undefined,
      fakeExtensionContext(projectA),
    );
    expect(
      Object.keys(
        JSON.parse(
          readFileSync(resolvedGeneratedPath(userDir, projectA), "utf8"),
        ).mcpServers,
      ),
    ).toEqual(["alpha"]);
  });

  it("keeps MCP servers alive when the executing config is unchanged", async () => {
    let sessionStarts = 0;
    vi.doMock("pi-mcp-adapter/index.ts", () => ({
      default: (pi: {
        on: (
          event: string,
          handler: (event: unknown, ctx: Record<string, unknown>) => unknown,
        ) => void;
        registerTool: (tool: Record<string, unknown>) => void;
      }) => {
        pi.on("session_start", () => {
          sessionStarts += 1;
        });
        pi.registerTool({
          name: "probe",
          execute: () => "ok",
        });
      },
    }));
    try {
      const root = tempRoot();
      const userDir = join(root, "user");
      const project = join(root, "project");
      mkdirSync(project, { recursive: true });
      write(
        join(userDir, "config.toml"),
        `
[mcp]
project_configs = "auto-load"
`,
      );
      write(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { alpha: { command: "node" } } }),
      );

      const tools: Record<string, Record<string, unknown>> = {};
      await buildAethonMcpExtension({ userDir, cwd: project })({
        registerFlag: () => {},
        registerTool: (tool: { name: string } & Record<string, unknown>) => {
          tools[tool.name] = tool;
        },
        registerCommand: () => {},
        getAllTools: () => [],
        getFlag: () => undefined,
        on: () => {},
      });
      const execute = tools.probe.execute as (
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: Record<string, unknown>,
      ) => Promise<unknown>;

      await execute(
        "call-1",
        {},
        undefined,
        undefined,
        fakeExtensionContext(project),
      );
      await execute(
        "call-2",
        {},
        undefined,
        undefined,
        fakeExtensionContext(project),
      );

      expect(sessionStarts).toBe(1);

      write(
        join(project, ".mcp.json"),
        JSON.stringify({ mcpServers: { beta: { command: "node" } } }),
      );

      await execute(
        "call-3",
        {},
        undefined,
        undefined,
        fakeExtensionContext(project),
      );

      expect(sessionStarts).toBe(2);
    } finally {
      vi.doUnmock("pi-mcp-adapter/index.ts");
    }
  });
});

function resolvedGeneratedPath(userDir: string, project: string): string {
  return resolveAethonMcpConfig({
    userDir,
    cwd: project,
    write: false,
  }).generatedPath;
}

function fakeExtensionContext(cwd: string): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    ui: {},
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
}
