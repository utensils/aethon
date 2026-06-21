import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AethonDebugClient, type DebugClientOptions, invokeJs } from "./debugClient.ts";

export type JsonRecord = Record<string, unknown>;

export interface AuthProfileMeta {
  id: string;
  providerId: string;
  label: string;
  kind: "oauth" | "api_key";
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface TabSummary {
  id: string;
  label?: string;
  kind?: string;
  cwd?: string;
  model?: string;
  waiting?: boolean;
  authProfileId?: string;
}

export interface AccountSwitchTarget {
  tabId: string;
  cwd?: string;
  model?: string;
}

export function jsonPointerGet(value: unknown, pointer = ""): unknown {
  if (!pointer || pointer === "/") return pointer === "/" ? getChild(value, "") : value;
  if (!pointer.startsWith("/")) throw new Error(`state path must be a JSON Pointer, got ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .reduce((current, part) => getChild(current, part.replace(/~1/g, "/").replace(/~0/g, "~")), value);
}

function getChild(value: unknown, key: string): unknown {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value[Number(key)];
  if (typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

export function normalizeTabs(value: unknown): TabSummary[] {
  if (Array.isArray(value)) return value.filter(isObject).map(tabSummary);
  if (isObject(value)) return Object.values(value).filter(isObject).map(tabSummary);
  return [];
}

function tabSummary(value: JsonRecord): TabSummary {
  return {
    id: typeof value.id === "string" ? value.id : "",
    label: typeof value.label === "string" ? value.label : undefined,
    kind: typeof value.kind === "string" ? value.kind : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    waiting: typeof value.waiting === "boolean" ? value.waiting : undefined,
    authProfileId: typeof value.authProfileId === "string" ? value.authProfileId : undefined,
  };
}

export function buildAccountSwitchPayloads(
  profileId: string,
  target: AccountSwitchTarget,
): JsonRecord[] {
  const base = {
    type: "auth_profile_use_for_tab",
    tabId: target.tabId,
    profileId,
  };
  if (!target.tabId || target.tabId === "default") return [base];
  return [
    base,
    {
      type: "auth_profile_apply",
      tabId: target.tabId,
      profileId,
      ...(target.cwd ? { cwd: target.cwd } : {}),
      ...(target.model ? { model: target.model } : {}),
    },
  ];
}

export function skillMarkdown(commandName = "aethonctl"): string {
  return `---
name: aethon-control
description: Control a running Aethon application from the command line. Inspect state, dispatch agent prompts, switch configured accounts, and install this skill.
when_to_use: Use when you need to drive or inspect Aethon from an agent session without manual UI interaction.
allowed-tools: Bash
---

# Aethon Control

Use \`${commandName}\` to control the running Aethon app over its local authenticated control socket.

Core commands:

\`\`\`bash
${commandName} status --json
${commandName} tabs
${commandName} models
${commandName} accounts list
${commandName} accounts use <profile-id> --tab active
${commandName} chat send "implement the next step" --account <profile-id> --wait
${commandName} agent stop --tab active
\`\`\`

Account rule: when dispatching to Codex-backed models, choose the intended configured account explicitly with \`--account <profile-id>\` or run \`accounts use\` first. The CLI applies the same global plus tab-worker account switch payloads as the Aethon UI.

Release builds are supported. The CLI reads \`~/.aethon/control/control.json\` and authenticates with the per-launch token in \`~/.aethon/control/token\`. Debug-only commands such as \`eval\` and raw \`invoke\` require \`--transport debug\`.
`;
}

export const SKILL_DIR_NAME = "aethon-control";
export type SkillTarget = "claude" | "codex" | "agents";

const TARGETS: Record<SkillTarget, { user: string[]; project: string[]; detect: string[] }> = {
  claude: { user: [".claude", "skills"], project: [".claude", "skills"], detect: [".claude"] },
  codex: { user: [".codex", "skills"], project: [".agents", "skills"], detect: [".codex"] },
  agents: { user: [".agents", "skills"], project: [".agents", "skills"], detect: [".agents"] },
};

export interface SkillInstallPlan {
  targets: SkillTarget[];
  paths: string[];
  content: string;
}

export function planSkillInstall(options: {
  targets?: string[];
  project?: boolean;
  dir?: string;
  home?: string;
  commandName?: string;
}): SkillInstallPlan {
  const project = options.project === true || Boolean(options.dir);
  const root = resolve(options.dir ?? (project ? "." : (options.home ?? process.env.HOME ?? ".")));
  const requested = expandSkillTargets(options.targets, project, options.home);
  const paths = dedupe(
    requested.map((target) =>
      join(root, ...TARGETS[target][project ? "project" : "user"], SKILL_DIR_NAME, "SKILL.md"),
    ),
  );
  return {
    targets: requested,
    paths,
    content: skillMarkdown(options.commandName),
  };
}

function expandSkillTargets(
  targets: string[] | undefined,
  project: boolean,
  home = process.env.HOME,
): SkillTarget[] {
  if (!targets || targets.length === 0) {
    if (project) return ["claude", "agents"];
    const detected = (Object.keys(TARGETS) as SkillTarget[]).filter((target) => {
      if (target === "agents") return false;
      return pathExists(join(home ?? "", ...TARGETS[target].detect));
    });
    return detected.length > 0 ? detected : ["agents"];
  }
  const expanded: SkillTarget[] = [];
  for (const target of targets) {
    if (target === "all") {
      expanded.push("claude", "codex", "agents");
    } else if (target === "claude" || target === "codex" || target === "agents") {
      expanded.push(target);
    } else {
      throw new Error(`unknown skill target: ${target}`);
    }
  }
  return dedupe(expanded);
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

export function installSkill(plan: SkillInstallPlan, force = false): string[] {
  for (const path of plan.paths) {
    if (!force && existsSync(path)) {
      throw new Error(`${path} already exists; pass --force to overwrite`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan.content);
  }
  return plan.paths;
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface AethonStateSnapshot {
  location: string;
  state: JsonRecord;
}

export async function fetchSnapshot(client: AethonDebugClient): Promise<AethonStateSnapshot> {
  return client.evalJson<AethonStateSnapshot>(`
return {
  location: window.location.href,
  state: window.__AETHON_STATE__ ? window.__AETHON_STATE__() : {},
};
`);
}

export function activeTargetFromState(state: JsonRecord, requestedTab: string | undefined): AccountSwitchTarget {
  const tabs = normalizeTabs(state.tabs);
  const tabId = requestedTab && requestedTab !== "active"
    ? requestedTab
    : typeof state.activeTabId === "string"
      ? state.activeTabId
      : undefined;
  const tab = tabId ? tabs.find((candidate) => candidate.id === tabId) : undefined;
  if (!tab && requestedTab && requestedTab !== "active" && requestedTab !== "default") {
    return { tabId: requestedTab };
  }
  if (!tab || tab.kind === "shell" || tab.kind === "editor") return { tabId: "default" };
  return {
    tabId: tab.id,
    cwd: tab.cwd,
    model: tab.model,
  };
}

export async function applyAccountSwitch(
  client: AethonDebugClient,
  profileId: string,
  target: AccountSwitchTarget,
): Promise<JsonRecord[]> {
  const payloads = buildAccountSwitchPayloads(profileId, target);
  for (const payload of payloads) {
    await client.invoke("agent_command", { payload: JSON.stringify(payload) });
  }
  return payloads;
}

export async function sendChat(
  client: AethonDebugClient,
  message: string,
  options: {
    tabId?: string;
    cwd?: string;
    model?: string;
    thinkingLevel?: string;
    account?: string;
    planMode?: boolean;
    mode?: string;
  },
): Promise<void> {
  await client.invoke("send_message", {
    request: {
      message,
      mode: options.mode ?? "normal",
      ...(options.tabId ? { tabId: options.tabId } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
      ...(options.account ? { authProfileId: options.account } : {}),
    },
  });
}

export async function openAgentTab(
  client: AethonDebugClient,
  options: {
    tabId?: string;
    cwd?: string;
    label?: string;
    model?: string;
    account?: string;
  } = {},
): Promise<TabSummary> {
  const tab = await client.evalJson<TabSummary>(`
const invoke = window.__AETHON_INVOKE__ || window.__TAURI_INTERNALS__?.invoke;
const s = window.__AETHON_STATE__();
const tabId = ${JSON.stringify(options.tabId)} || crypto.randomUUID();
const cwd = ${JSON.stringify(options.cwd)} ||
  (Array.isArray(s.projects) ? s.projects.find((p) => p.id === s.activeProjectId)?.path : undefined) ||
  s.projectRoot ||
  s.aethonRoot;
if (!cwd) throw new Error("tabs new could not resolve a cwd; pass --cwd");
const model = ${JSON.stringify(options.model)} || s.model || s.defaultModel || "";
const tab = {
  id: tabId,
  kind: "agent",
  label: ${JSON.stringify(options.label)} || "CLI",
  messages: [],
  draft: "",
  waiting: false,
  queuedMessages: [],
  queueCount: 0,
  canvas: null,
  terminalBuffer: "",
  projectId: typeof s.activeProjectId === "string" ? s.activeProjectId : null,
  cwd,
  model,
  ${options.account ? `authProfileId: ${JSON.stringify(options.account)},` : ""}
};
const tabs = Array.isArray(s.tabs)
  ? [...s.tabs.filter((candidate) => candidate?.id !== tabId), tab]
  : { ...(s.tabs || {}), [tabId]: tab };
window.__AETHON_SET_STATE__({ ...s, tabs, activeTabId: tabId, hasTabs: true, model });
await invoke("agent_command", {
  payload: JSON.stringify({
    type: "tab_open",
    tabId,
    cwd,
    ...(model ? { model } : {}),
  }),
});
return { id: tabId, kind: "agent", label: tab.label, cwd, model };
`);
  if (options.account) {
    await applyAccountSwitch(client, options.account, {
      tabId: tab.id,
      cwd: tab.cwd,
      model: tab.model,
    });
  }
  return tab;
}

export async function closeAgentTab(client: AethonDebugClient, tabId: string): Promise<void> {
  await client.eval(`
const invoke = window.__AETHON_INVOKE__ || window.__TAURI_INTERNALS__?.invoke;
const s = window.__AETHON_STATE__();
const tabs = Array.isArray(s.tabs)
  ? s.tabs.filter((candidate) => candidate?.id !== ${JSON.stringify(tabId)})
  : Object.fromEntries(Object.entries(s.tabs || {}).filter(([id]) => id !== ${JSON.stringify(tabId)}));
const activeTabId = s.activeTabId === ${JSON.stringify(tabId)}
  ? (Array.isArray(tabs) ? tabs.find((tab) => tab?.kind === "agent")?.id : Object.values(tabs).find((tab) => tab?.kind === "agent")?.id)
  : s.activeTabId;
window.__AETHON_SET_STATE__({ ...s, tabs, activeTabId, hasTabs: Array.isArray(tabs) ? tabs.length > 0 : Object.keys(tabs).length > 0 });
await invoke("agent_command", { payload: JSON.stringify({ type: "tab_close", tabId: ${JSON.stringify(tabId)} }) });
return "closed";
`);
}

export async function waitUntilIdle(
  client: AethonDebugClient,
  timeoutMs: number,
): Promise<JsonRecord> {
  return client.evalJson<JsonRecord>(`
const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
while (Date.now() < deadline) {
  const s = window.__AETHON_STATE__();
  if (s.waiting !== true) {
    return {
      waiting: false,
      status: s.status,
      activeTabId: s.activeTabId,
      messageCount: Array.isArray(s.messages) ? s.messages.length : undefined,
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
return { waiting: true, timeoutMs: ${JSON.stringify(timeoutMs)} };
`);
}

export function rawAgentCommandJs(payload: unknown): string {
  return invokeJs("agent_command", { payload: JSON.stringify(payload) });
}

export function createClient(options: DebugClientOptions): AethonDebugClient {
  return new AethonDebugClient(options);
}
