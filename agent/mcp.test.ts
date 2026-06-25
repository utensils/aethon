import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  approveAethonMcpProjectConfig,
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
imports = ["claude-code"]
tool_prefix = "srv"
idle_timeout_minutes = 9
auto_auth = true

[mcp.servers.context7]
command = "npx"
args = ["-y", "@context7/mcp"]
env = { CONTEXT7_API_KEY = "$CONTEXT7_API_KEY" }
lifecycle = "lazy"
direct_tools = true
`,
    );

    const resolved = resolveAethonMcpConfig({ userDir, cwd: project });

    expect(resolved.enabled).toBe(true);
    expect(resolved.config.imports).toEqual(["claude-code"]);
    expect(resolved.config.settings).toMatchObject({
      toolPrefix: "srv",
      idleTimeout: 9,
      autoAuth: true,
    });
    expect(resolved.config.mcpServers.context7).toEqual({
      command: "npx",
      args: ["-y", "@context7/mcp"],
      env: { CONTEXT7_API_KEY: "$CONTEXT7_API_KEY" },
      lifecycle: "lazy",
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
  });
});
