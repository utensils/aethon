import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

type JsonObject = Record<string, unknown>;

type ProjectConfigMode = "require-approval" | "auto-load" | "never";

interface AdapterServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: unknown;
  oauth?: unknown;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "lazy" | "session" | "persistent";
  idleTimeout?: number;
  exposeResources?: boolean;
  excludeTools?: string[];
  debug?: boolean;
}

interface AdapterConfig {
  settings: JsonObject;
  imports: string[];
  mcpServers: Record<string, AdapterServer>;
}

interface ProjectSource {
  kind: "aethon-toml" | "claude-json" | "pi-json";
  path: string;
  relativePath: string;
  text: string;
}

interface SourceConfig {
  settings: JsonObject;
  imports: string[];
  mcpServers: Record<string, AdapterServer>;
  warnings: string[];
}

export interface McpProjectApproval {
  required: boolean;
  approved: boolean;
  root: string;
  fingerprint: string | null;
  sources: string[];
  mode: ProjectConfigMode;
}

export interface ResolvedAethonMcpConfig {
  enabled: boolean;
  config: AdapterConfig;
  generatedPath: string;
  adapterCwd: string;
  projectApproval: McpProjectApproval;
  warnings: string[];
}

const PROJECT_CONFIGS: Array<Omit<ProjectSource, "path" | "text">> = [
  { kind: "claude-json", relativePath: ".mcp.json" },
  { kind: "pi-json", relativePath: ".pi/mcp.json" },
  { kind: "aethon-toml", relativePath: ".aethon/mcp.toml" },
];

const APPROVALS_FILE = "mcp-approvals.json";
const GENERATED_FILE = "generated.json";
const MAX_CONFIG_BYTES = 256 * 1024;

function emptyConfig(): AdapterConfig {
  return { settings: {}, imports: [], mcpServers: {} };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeLifecycle(value: unknown): AdapterServer["lifecycle"] {
  return value === "lazy" || value === "session" || value === "persistent"
    ? value
    : undefined;
}

function normalizeProjectConfigMode(value: unknown): ProjectConfigMode {
  if (value === "auto-load" || value === "auto_load" || value === "always") {
    return "auto-load";
  }
  if (value === "never" || value === "disabled" || value === false) {
    return "never";
  }
  return "require-approval";
}

function readLimitedText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_CONFIG_BYTES ? text.slice(0, MAX_CONFIG_BYTES) : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseTomlObject(text: string, label: string): {
  root: JsonObject;
  warning?: string;
} {
  try {
    const parsed = text.trim() ? parseToml(text) : {};
    return { root: isRecord(parsed) ? parsed : {} };
  } catch (err) {
    return {
      root: {},
      warning: `Could not parse ${label}; MCP servers from that file were skipped: ${
        (err as Error).message
      }`,
    };
  }
}

function parseJsonObject(text: string, label: string): {
  root: JsonObject;
  warning?: string;
} {
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    return { root: isRecord(parsed) ? parsed : {} };
  } catch (err) {
    return {
      root: {},
      warning: `Could not parse ${label}; MCP servers from that file were skipped: ${
        (err as Error).message
      }`,
    };
  }
}

function normalizeSettings(raw: JsonObject): JsonObject {
  const settings: JsonObject = {};
  const toolPrefix = stringValue(raw.tool_prefix ?? raw.toolPrefix);
  if (toolPrefix) settings.toolPrefix = toolPrefix;
  const idleTimeout =
    finiteNumber(raw.idle_timeout_minutes) ?? finiteNumber(raw.idleTimeout);
  if (idleTimeout !== undefined) settings.idleTimeout = idleTimeout;
  const autoAuth = boolValue(raw.auto_auth ?? raw.autoAuth);
  if (autoAuth !== undefined) settings.autoAuth = autoAuth;
  const samplingAutoApprove = boolValue(
    raw.sampling_auto_approve ?? raw.samplingAutoApprove,
  );
  if (samplingAutoApprove !== undefined) {
    settings.samplingAutoApprove = samplingAutoApprove;
  }
  return settings;
}

function normalizeServer(raw: unknown, projectRoot?: string): AdapterServer | null {
  if (!isRecord(raw)) return null;
  const server: AdapterServer = {};

  const command = stringValue(raw.command);
  const url = stringValue(raw.url);
  if (command) server.command = command;
  if (url) server.url = url;
  if (!server.command && !server.url) return null;

  const args = stringArray(raw.args);
  if (args.length > 0) server.args = args;

  const env = stringRecord(raw.env);
  if (env) server.env = env;

  const cwd = stringValue(raw.cwd);
  if (cwd) {
    server.cwd =
      projectRoot && !isAbsolute(cwd) ? resolve(projectRoot, cwd) : cwd;
  }
  else if (projectRoot && server.command) server.cwd = projectRoot;

  const headers = stringRecord(raw.headers);
  if (headers) server.headers = headers;

  if (raw.auth !== undefined) server.auth = raw.auth;
  if (raw.oauth !== undefined) server.oauth = raw.oauth;

  const bearerToken = stringValue(raw.bearer_token ?? raw.bearerToken);
  if (bearerToken) server.bearerToken = bearerToken;
  const bearerTokenEnv = stringValue(raw.bearer_token_env ?? raw.bearerTokenEnv);
  if (bearerTokenEnv) server.bearerTokenEnv = bearerTokenEnv;

  const lifecycle = normalizeLifecycle(raw.lifecycle);
  if (lifecycle) server.lifecycle = lifecycle;

  const idleTimeout =
    finiteNumber(raw.idle_timeout_minutes) ?? finiteNumber(raw.idleTimeout);
  if (idleTimeout !== undefined) server.idleTimeout = idleTimeout;

  const exposeResources = boolValue(raw.expose_resources ?? raw.exposeResources);
  if (exposeResources !== undefined) server.exposeResources = exposeResources;

  const excludeTools = stringArray(raw.exclude_tools ?? raw.excludeTools);
  if (excludeTools.length > 0) server.excludeTools = excludeTools;

  const debug = boolValue(raw.debug);
  if (debug !== undefined) server.debug = debug;

  return server;
}

function mergeInto(target: AdapterConfig, next: SourceConfig): void {
  Object.assign(target.settings, next.settings);
  target.imports = [...new Set([...target.imports, ...next.imports])];
  Object.assign(target.mcpServers, next.mcpServers);
}

function parseTomlConfig(
  text: string,
  label: string,
  projectRoot?: string,
): SourceConfig & { enabled?: boolean; projectConfigMode: ProjectConfigMode } {
  const { root, warning } = parseTomlObject(text, label);
  const warnings = warning ? [warning] : [];
  const rawMcp = isRecord(root.mcp) ? root.mcp : root;
  const serversRoot = isRecord(rawMcp.servers) ? rawMcp.servers : {};
  const mcpServers: Record<string, AdapterServer> = {};
  for (const [name, raw] of Object.entries(serversRoot)) {
    const server = normalizeServer(raw, projectRoot);
    if (server) mcpServers[name] = server;
  }
  return {
    settings: normalizeSettings(rawMcp),
    imports: stringArray(rawMcp.imports),
    mcpServers,
    warnings,
    enabled: boolValue(rawMcp.enabled),
    projectConfigMode: normalizeProjectConfigMode(rawMcp.project_configs),
  };
}

function parseJsonConfig(
  text: string,
  label: string,
  projectRoot?: string,
): SourceConfig {
  const { root, warning } = parseJsonObject(text, label);
  const warnings = warning ? [warning] : [];
  const serversRoot = isRecord(root.mcpServers) ? root.mcpServers : {};
  const mcpServers: Record<string, AdapterServer> = {};
  for (const [name, raw] of Object.entries(serversRoot)) {
    const server = normalizeServer(raw, projectRoot);
    if (server) mcpServers[name] = server;
  }
  return {
    settings: isRecord(root.settings) ? normalizeSettings(root.settings) : {},
    imports: stringArray(root.imports),
    mcpServers,
    warnings,
  };
}

function canonicalizeRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function discoverProjectSources(projectRoot: string): ProjectSource[] {
  return PROJECT_CONFIGS.flatMap((source) => {
    const path = join(projectRoot, source.relativePath);
    const text = readLimitedText(path);
    return text === null ? [] : [{ ...source, path, text }];
  });
}

function projectFingerprint(projectRoot: string, sources: ProjectSource[]): string | null {
  if (sources.length === 0) return null;
  const hash = createHash("sha1");
  hash.update("aethon-mcp-v1\0");
  hash.update(projectRoot);
  hash.update("\0");
  for (const source of sources) {
    hash.update(source.relativePath);
    hash.update("\0");
    hash.update(source.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function approvalStorePath(userDir: string): string {
  return join(userDir, APPROVALS_FILE);
}

function readApprovalStore(userDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(approvalStorePath(userDir), "utf8"));
    return isRecord(parsed.approvals) ? (parsed.approvals as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeGeneratedConfig(userDir: string, config: AdapterConfig): string {
  const dir = join(userDir, "mcp", "generated");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, GENERATED_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

function adapterCwd(userDir: string): string {
  const dir = join(userDir, "mcp", "adapter-cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function approveAethonMcpProjectConfig(
  userDir: string,
  cwd: string,
): McpProjectApproval {
  mkdirSync(userDir, { recursive: true });
  const root = canonicalizeRoot(cwd);
  const sources = discoverProjectSources(root);
  const fingerprint = projectFingerprint(root, sources);
  const approvals = readApprovalStore(userDir);
  if (fingerprint) approvals[root] = fingerprint;
  writeFileSync(
    approvalStorePath(userDir),
    `${JSON.stringify({ approvals }, null, 2)}\n`,
  );
  return {
    required: sources.length > 0,
    approved: sources.length > 0,
    root,
    fingerprint,
    sources: sources.map((source) => source.relativePath),
    mode: "require-approval",
  };
}

export function resolveAethonMcpConfig(options: {
  userDir: string;
  cwd: string;
  write?: boolean;
}): ResolvedAethonMcpConfig {
  const userDir = options.userDir;
  const projectRoot = canonicalizeRoot(options.cwd);
  const config = emptyConfig();
  const warnings: string[] = [];

  const hostPath = join(userDir, "config.toml");
  const sources = discoverProjectSources(projectRoot);
  const hostText = readLimitedText(hostPath) ?? "";
  const host = parseTomlConfig(hostText, "~/.aethon/config.toml");
  warnings.push(...host.warnings);
  mergeInto(config, host);

  const enabled = host.enabled !== false;
  const projectMode = host.projectConfigMode;
  const fingerprint = projectFingerprint(projectRoot, sources);
  const approved =
    projectMode === "auto-load" ||
    (fingerprint !== null &&
      readApprovalStore(userDir)[projectRoot] === fingerprint);
  const shouldLoadProject = enabled && projectMode !== "never" && approved;

  if (shouldLoadProject) {
    for (const source of sources) {
      const parsed =
        source.kind === "aethon-toml"
          ? parseTomlConfig(source.text, source.relativePath, projectRoot)
          : parseJsonConfig(source.text, source.relativePath, projectRoot);
      warnings.push(...parsed.warnings);
      mergeInto(config, parsed);
    }
  }

  const generatedPath = options.write
    ? writeGeneratedConfig(userDir, enabled ? config : emptyConfig())
    : join(userDir, "mcp", "generated", GENERATED_FILE);
  const cwd = adapterCwd(userDir);

  return {
    enabled,
    config: enabled ? config : emptyConfig(),
    generatedPath,
    adapterCwd: cwd,
    projectApproval: {
      required: enabled && projectMode !== "never" && sources.length > 0,
      approved: enabled && projectMode !== "never" && approved,
      root: projectRoot,
      fingerprint,
      sources: sources.map((source) => source.relativePath),
      mode: projectMode,
    },
    warnings,
  };
}

type PiLike = {
  getFlag?: (name: string) => unknown;
  on?: (event: string, handler: (...args: unknown[]) => unknown) => void;
  [key: string]: unknown;
};

export function buildAethonMcpExtension(state: {
  userDir: string;
}): ExtensionFactory {
  const storage = new AsyncLocalStorage<{ configPath: string }>();
  return async (pi: PiLike) => {
    const host = parseTomlConfig(
      readLimitedText(join(state.userDir, "config.toml")) ?? "",
      "~/.aethon/config.toml",
    );
    if (host.enabled === false) return;

    const originalGetFlag = pi.getFlag?.bind(pi);
    const originalOn = pi.on?.bind(pi);
    const wrappedPi = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop === "getFlag") {
          return (name: string) => {
            if (name === "mcp-config") {
              return storage.getStore()?.configPath;
            }
            return originalGetFlag?.(name);
          };
        }
        if (prop === "on") {
          return (event: string, handler: (...args: unknown[]) => unknown) => {
            if (event !== "session_start") {
              originalOn?.(event, handler);
              return;
            }
            originalOn?.(event, (...args: unknown[]) => {
              const ctx = args.length >= 2 ? args[1] : args[0];
              const rawCwd =
                isRecord(ctx) && typeof ctx.cwd === "string"
                  ? ctx.cwd
                  : process.cwd();
              const resolved = resolveAethonMcpConfig({
                userDir: state.userDir,
                cwd: rawCwd,
                write: true,
              });
              const safeCtx = isRecord(ctx)
                ? { ...ctx, cwd: resolved.adapterCwd }
                : ctx;
              const safeArgs =
                args.length >= 2 ? [args[0], safeCtx, ...args.slice(2)] : [safeCtx];
              return storage.run(
                { configPath: resolved.generatedPath },
                () => handler(...safeArgs),
              );
            });
            return;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_DIRECT_TOOLS = "__none__";
    try {
      const imported = await import("pi-mcp-adapter/index.ts");
      imported.default?.(wrappedPi);
    } finally {
      if (previousDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = previousDirectTools;
    }
  };
}
