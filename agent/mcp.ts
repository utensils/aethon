import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  lifecycle?: "lazy" | "eager" | "keep-alive";
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
const PROJECT_RELATIVE_IMPORTS = new Set(["vscode"]);

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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
  if (value === "lazy") return "lazy";
  if (value === "session" || value === "eager") return "eager";
  if (
    value === "persistent" ||
    value === "keep-alive" ||
    value === "keep_alive"
  ) {
    return "keep-alive";
  }
  return undefined;
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

export function readLimitedText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES);
    const bytes = readSync(fd, buffer, 0, MAX_CONFIG_BYTES, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "EACCES" ||
      code === "EPERM"
    ) {
      return null;
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseTomlObject(
  text: string,
  label: string,
): {
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

function parseJsonObject(
  text: string,
  label: string,
): {
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

function normalizeServer(
  raw: unknown,
  projectRoot?: string,
): AdapterServer | null {
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
  } else if (projectRoot && server.command) server.cwd = projectRoot;

  const headers = stringRecord(raw.headers);
  if (headers) server.headers = headers;

  if (raw.auth !== undefined) server.auth = raw.auth;
  if (raw.oauth !== undefined) server.oauth = raw.oauth;

  const bearerToken = stringValue(raw.bearer_token ?? raw.bearerToken);
  if (bearerToken) server.bearerToken = bearerToken;
  const bearerTokenEnv = stringValue(
    raw.bearer_token_env ?? raw.bearerTokenEnv,
  );
  if (bearerTokenEnv) server.bearerTokenEnv = bearerTokenEnv;

  const lifecycle = normalizeLifecycle(raw.lifecycle);
  if (lifecycle) server.lifecycle = lifecycle;

  const idleTimeout =
    finiteNumber(raw.idle_timeout_minutes) ?? finiteNumber(raw.idleTimeout);
  if (idleTimeout !== undefined) server.idleTimeout = idleTimeout;

  const exposeResources = boolValue(
    raw.expose_resources ?? raw.exposeResources,
  );
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
  const serversRoot = isRecord(root.mcpServers)
    ? root.mcpServers
    : isRecord(root["mcp-servers"])
      ? root["mcp-servers"]
      : {};
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

const IMPORT_PATHS: Record<string, (projectRoot: string) => string[]> = {
  "claude-code": () => [
    join(homedir(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": () => [
    join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  ],
  codex: () => [join(homedir(), ".codex", "config.json")],
  cursor: () => [join(homedir(), ".cursor", "mcp.json")],
  vscode: (projectRoot) => [join(projectRoot, ".vscode", "mcp.json")],
  windsurf: () => [join(homedir(), ".windsurf", "mcp.json")],
};

function isInsideProject(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function importCandidatePaths(importName: string, projectRoot: string): string[] {
  const named = IMPORT_PATHS[importName]?.(projectRoot);
  if (named) return named;
  if (importName.startsWith("./") || importName.startsWith("../")) {
    return [resolve(projectRoot, importName)];
  }
  if (isAbsolute(importName)) return [importName];
  return [];
}

function safeProjectFilePath(projectRoot: string, path: string): string | null {
  try {
    lstatSync(path);
    const realRoot = realpathSync(projectRoot);
    const realPath = realpathSync(path);
    return isInsideProject(realRoot, realPath) ? realPath : null;
  } catch {
    return null;
  }
}

function resolveImportPath(
  importName: string,
  projectRoot: string,
  options?: { requireProjectSafe?: boolean },
): string | null {
  for (const candidate of importCandidatePaths(importName, projectRoot)) {
    const path = options?.requireProjectSafe
      ? safeProjectFilePath(projectRoot, candidate)
      : candidate;
    if (path && existsSync(path)) return path;
  }
  return null;
}

function resolveProjectImportPath(
  importName: string,
  projectRoot: string,
): string | null {
  for (const candidate of importCandidatePaths(importName, projectRoot)) {
    const path = safeProjectFilePath(projectRoot, candidate);
    if (path) return path;
  }
  return null;
}

function isProjectRelativeImport(
  importName: string,
  projectRoot: string,
): boolean {
  return (
    PROJECT_RELATIVE_IMPORTS.has(importName) ||
    importName.startsWith("./") ||
    importName.startsWith("../") ||
    (isAbsolute(importName) &&
      safeProjectFilePath(projectRoot, importName) !== null)
  );
}

function parseImportedConfig(
  text: string,
  importName: string,
  path: string,
  projectRoot: string,
): SourceConfig {
  const projectImport = isProjectRelativeImport(importName, projectRoot);
  const parserRoot = projectImport ? projectRoot : undefined;
  return path.endsWith(".toml")
    ? parseTomlConfig(text, `MCP import ${importName}`, parserRoot)
    : parseJsonConfig(text, `MCP import ${importName}`, parserRoot);
}

function expandImports(
  config: AdapterConfig,
  projectRoot: string,
  options?: { allowProjectImports?: boolean },
): AdapterConfig {
  const importedServers: Record<string, AdapterServer> = {};
  const unresolvedImports: string[] = [];
  for (const importName of config.imports) {
    const projectImport = isProjectRelativeImport(importName, projectRoot);
    if (projectImport && options?.allowProjectImports !== true) {
      continue;
    }
    const path = resolveImportPath(importName, projectRoot, {
      requireProjectSafe: projectImport,
    });
    if (!path) {
      if (!projectImport) unresolvedImports.push(importName);
      continue;
    }
    const text = readLimitedText(path);
    if (text === null) {
      if (!projectImport) unresolvedImports.push(importName);
      continue;
    }
    const parsed = parseImportedConfig(text, importName, path, projectRoot);
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      if (!importedServers[name]) importedServers[name] = server;
    }
  }
  return {
    settings: config.settings,
    imports: unresolvedImports,
    mcpServers: { ...importedServers, ...config.mcpServers },
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
    const declaredPath = join(projectRoot, source.relativePath);
    const path = safeProjectFilePath(projectRoot, declaredPath);
    if (!path) return [];
    const text = readLimitedText(path);
    return text === null ? [] : [{ ...source, path: declaredPath, text }];
  });
}

function projectImportSources(
  projectRoot: string,
  sources: ProjectSource[],
): Array<Pick<ProjectSource, "relativePath" | "text">> {
  const imports = sources.flatMap((source) =>
    source.kind === "aethon-toml"
      ? parseTomlConfig(source.text, source.relativePath, projectRoot).imports
      : parseJsonConfig(source.text, source.relativePath, projectRoot).imports,
  );
  return projectImportSourcesForImports(projectRoot, imports);
}

function projectImportSourcesForImports(
  projectRoot: string,
  imports: string[],
): Array<Pick<ProjectSource, "relativePath" | "text">> {
  const seen = new Set<string>();
  const imported: Array<Pick<ProjectSource, "relativePath" | "text">> = [];
  for (const importName of imports) {
    const path = resolveProjectImportPath(importName, projectRoot);
    if (!path || seen.has(path)) continue;
    const text = readLimitedText(path);
    if (text === null) continue;
    seen.add(path);
    imported.push({
      relativePath: relative(projectRoot, path) || path,
      text,
    });
  }
  return imported;
}

function projectApprovalEntries(
  projectRoot: string,
  sources: ProjectSource[],
  hostProjectImports: Array<Pick<ProjectSource, "relativePath" | "text">>,
): Array<Pick<ProjectSource, "relativePath" | "text">> {
  const seen = new Set<string>();
  const entries: Array<Pick<ProjectSource, "relativePath" | "text">> = [];
  for (const source of [
    ...sources,
    ...projectImportSources(projectRoot, sources),
    ...hostProjectImports,
  ]) {
    if (seen.has(source.relativePath)) continue;
    seen.add(source.relativePath);
    entries.push(source);
  }
  return entries;
}

function projectApprovalSourcePaths(
  projectRoot: string,
  sources: ProjectSource[],
  hostProjectImports: Array<Pick<ProjectSource, "relativePath" | "text">>,
): string[] {
  return projectApprovalEntries(projectRoot, sources, hostProjectImports).map(
    (source) => source.relativePath,
  );
}

function projectFingerprint(
  projectRoot: string,
  sources: ProjectSource[],
  hostProjectImports: Array<Pick<ProjectSource, "relativePath" | "text">>,
): string | null {
  const entries = projectApprovalEntries(
    projectRoot,
    sources,
    hostProjectImports,
  );
  if (entries.length === 0) return null;
  const hash = createHash("sha1");
  hash.update("aethon-mcp-v1\0");
  hash.update(projectRoot);
  hash.update("\0");
  for (const source of entries) {
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
    return isRecord(parsed.approvals)
      ? (parsed.approvals as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function generatedConfigPath(userDir: string, projectRoot: string): string {
  const dir = join(userDir, "mcp", "generated");
  mkdirSync(dir, { recursive: true });
  const name = `${createHash("sha1").update(projectRoot).digest("hex")}.json`;
  return join(dir, name || GENERATED_FILE);
}

function writeGeneratedConfig(
  userDir: string,
  projectRoot: string,
  config: AdapterConfig,
): string {
  const target = generatedConfigPath(userDir, projectRoot);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

function adapterCwd(userDir: string): string {
  const dir = join(userDir, "mcp", "adapter-cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function adapterHome(userDir: string): string {
  const dir = join(userDir, "mcp", "adapter-home");
  mkdirSync(join(dir, ".config", "mcp"), { recursive: true });
  return dir;
}

async function withAdapterHome<T>(
  home: string,
  task: () => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await task();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

export function approveAethonMcpProjectConfig(
  userDir: string,
  cwd: string,
): McpProjectApproval {
  mkdirSync(userDir, { recursive: true });
  const root = canonicalizeRoot(cwd);
  const sources = discoverProjectSources(root);
  const hostText = readLimitedText(join(userDir, "config.toml")) ?? "";
  const host = parseTomlConfig(hostText, "~/.aethon/config.toml");
  const hostProjectImports = projectImportSourcesForImports(root, host.imports);
  const fingerprint = projectFingerprint(root, sources, hostProjectImports);
  const approvals = readApprovalStore(userDir);
  if (fingerprint) approvals[root] = fingerprint;
  writeFileSync(
    approvalStorePath(userDir),
    `${JSON.stringify({ approvals }, null, 2)}\n`,
  );
  const approvalEntries = projectApprovalEntries(root, sources, hostProjectImports);
  return {
    required: approvalEntries.length > 0,
    approved: approvalEntries.length > 0,
    root,
    fingerprint,
    sources: projectApprovalSourcePaths(root, sources, hostProjectImports),
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
  const hostProjectImports = projectImportSourcesForImports(
    projectRoot,
    host.imports,
  );
  warnings.push(...host.warnings);
  mergeInto(config, host);

  const enabled = host.enabled !== false;
  const projectMode = host.projectConfigMode;
  const fingerprint = projectFingerprint(
    projectRoot,
    sources,
    hostProjectImports,
  );
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
  const adapterConfig = expandImports(
    enabled ? config : emptyConfig(),
    projectRoot,
    {
      allowProjectImports:
        enabled && projectMode !== "never" && approved === true,
    },
  );

  const generatedPath = options.write
    ? writeGeneratedConfig(userDir, projectRoot, adapterConfig)
    : generatedConfigPath(userDir, projectRoot);
  const cwd = adapterCwd(userDir);

  return {
    enabled,
    config: adapterConfig,
    generatedPath,
    adapterCwd: cwd,
    projectApproval: {
      required:
        enabled &&
        projectMode !== "never" &&
        projectApprovalEntries(projectRoot, sources, hostProjectImports)
          .length > 0,
      approved: enabled && projectMode !== "never" && approved,
      root: projectRoot,
      fingerprint,
      sources: projectApprovalSourcePaths(
        projectRoot,
        sources,
        hostProjectImports,
      ),
      mode: projectMode,
    },
    warnings,
  };
}

type PiLike = {
  getFlag?: (name: string) => unknown;
  on?: (event: string, handler: (...args: unknown[]) => unknown) => void;
  registerCommand?: (name: string, options: Record<string, unknown>) => void;
  registerTool?: (tool: Record<string, unknown>) => void;
  [key: string]: unknown;
};

export function buildAethonMcpExtension(state: {
  userDir: string;
  cwd?: string;
}): ExtensionFactory {
  const storage = new AsyncLocalStorage<{ configPath: string }>();
  return async (pi: PiLike) => {
    const host = parseTomlConfig(
      readLimitedText(join(state.userDir, "config.toml")) ?? "",
      "~/.aethon/config.toml",
    );
    if (host.enabled === false) return;
    let currentConfigPath = resolveAethonMcpConfig({
      userDir: state.userDir,
      cwd: state.cwd ?? process.cwd(),
      write: true,
    }).generatedPath;
    let activeSessionKey: string | null = null;

    let sessionStartHandler:
      | ((event: unknown, ctx: Record<string, unknown>) => unknown)
      | undefined;
    let operationQueue = Promise.resolve();

    const originalGetFlag = pi.getFlag?.bind(pi);
    const originalOn = pi.on?.bind(pi);
    const originalRegisterCommand = pi.registerCommand?.bind(pi);
    const originalRegisterTool = pi.registerTool?.bind(pi);

    const resolveForContext = (ctx: unknown) => {
      const rawCwd =
        isRecord(ctx) && typeof ctx.cwd === "string"
          ? ctx.cwd
          : (state.cwd ?? process.cwd());
      const resolved = resolveAethonMcpConfig({
        userDir: state.userDir,
        cwd: rawCwd,
        write: true,
      });
      currentConfigPath = resolved.generatedPath;
      const safeCtx = isRecord(ctx)
        ? { ...ctx, cwd: resolved.adapterCwd }
        : { cwd: resolved.adapterCwd };
      return { resolved, safeCtx };
    };

    const sessionKeyFor = (resolved: ResolvedAethonMcpConfig): string => {
      const digest = createHash("sha256")
        .update(JSON.stringify(resolved.config))
        .digest("hex");
      return `${resolved.generatedPath}\0${digest}`;
    };

    const runSerialized = async <T>(task: () => Promise<T>): Promise<T> => {
      const previous = operationQueue;
      let release: () => void = () => {};
      operationQueue = previous
        .catch(() => {})
        .then(
          () =>
            new Promise<void>((resolveRelease) => {
              release = resolveRelease;
            }),
        );
      await previous.catch(() => {});
      try {
        return await task();
      } finally {
        release();
      }
    };

    const refreshForContext = async (
      ctx: unknown,
    ): Promise<{ configPath: string; safeCtx: Record<string, unknown> }> => {
      const { resolved, safeCtx } = resolveForContext(ctx);
      const sessionKey = sessionKeyFor(resolved);
      if (sessionStartHandler && activeSessionKey !== sessionKey) {
        await storage.run({ configPath: resolved.generatedPath }, async () => {
          await sessionStartHandler?.(
            { type: "session_start", reason: "reload" },
            safeCtx,
          );
          activeSessionKey = sessionKey;
        });
      }
      return { configPath: resolved.generatedPath, safeCtx };
    };

    const wrappedPi = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop === "getFlag") {
          return (name: string) => {
            if (name === "mcp-config") {
              return storage.getStore()?.configPath ?? currentConfigPath;
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
            sessionStartHandler = handler;
            originalOn?.(event, (...args: unknown[]) => {
              const ctx = args.length >= 2 ? args[1] : args[0];
              const { resolved, safeCtx } = resolveForContext(ctx);
              const safeArgs =
                args.length >= 2
                  ? [args[0], safeCtx, ...args.slice(2)]
                  : [safeCtx];
              return runSerialized(() =>
                storage.run({ configPath: resolved.generatedPath }, () =>
                  Promise.resolve(handler(...safeArgs)).then((result) => {
                    activeSessionKey = sessionKeyFor(resolved);
                    return result;
                  }),
                ),
              );
            });
            return;
          };
        }
        if (prop === "registerCommand") {
          return (name: string, options: Record<string, unknown>) => {
            const handler = options.handler;
            if (typeof handler !== "function") {
              originalRegisterCommand?.(name, options);
              return;
            }
            originalRegisterCommand?.(name, {
              ...options,
              handler: (args: string, ctx: unknown) =>
                runSerialized(async () => {
                  const { configPath, safeCtx } = await refreshForContext(ctx);
                  return await storage.run({ configPath }, () =>
                    handler(args, safeCtx),
                  );
                }),
            });
          };
        }
        if (prop === "registerTool") {
          return (tool: Record<string, unknown>) => {
            const execute = tool.execute;
            if (typeof execute !== "function") {
              originalRegisterTool?.(tool);
              return;
            }
            originalRegisterTool?.({
              ...tool,
              execute: (
                toolCallId: string,
                params: unknown,
                signal: AbortSignal | undefined,
                onUpdate: unknown,
                ctx: unknown,
              ) =>
                runSerialized(async () => {
                  const { configPath, safeCtx } = await refreshForContext(ctx);
                  return await storage.run({ configPath }, () =>
                    execute(toolCallId, params, signal, onUpdate, safeCtx),
                  );
                }),
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
    const argvCleanup = pushMcpConfigArg(currentConfigPath);
    process.env.MCP_DIRECT_TOOLS = "__none__";
    try {
      const imported = await withAdapterHome(
        adapterHome(state.userDir),
        () => import("pi-mcp-adapter/index.ts"),
      );
      imported.default?.(wrappedPi);
    } finally {
      argvCleanup();
      if (previousDirectTools === undefined)
        delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = previousDirectTools;
    }
  };
}

function pushMcpConfigArg(configPath: string): () => void {
  const previous = process.argv.slice();
  const existing = process.argv.indexOf("--mcp-config");
  if (existing >= 0) {
    process.argv[existing + 1] = configPath;
  } else {
    process.argv.push("--mcp-config", configPath);
  }
  return () => {
    process.argv.splice(0, process.argv.length, ...previous);
  };
}
