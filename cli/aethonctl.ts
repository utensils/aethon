#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  activeTargetFromState,
  applyAccountSwitch,
  createClient,
  fetchSnapshot,
  installSkill,
  jsonPointerGet,
  normalizeTabs,
  closeAgentTab,
  openAgentTab,
  planSkillInstall,
  rawAgentCommandJs,
  sendChat,
  skillMarkdown,
  waitUntilIdle,
  type JsonRecord,
} from "./aethonControl.ts";

interface CliOptions {
  json: boolean;
  port?: number;
}

function print(value: unknown, json = false): void {
  if (json || typeof value !== "string") {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

function parseGlobal(argv: string[]): { options: CliOptions; args: string[] } {
  const options: CliOptions = { json: false };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--port") {
      const next = argv[++i];
      if (!next) throw new Error("--port requires a value");
      options.port = Number(next);
    } else {
      args.push(arg);
    }
  }
  return { options, args };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function optionFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function readMessage(args: string[]): string {
  const file = optionValue(args, "--file");
  if (file) return readFileSync(file, "utf8");
  if (args.length > 0) return args.join(" ");
  return readFileSync(0, "utf8");
}

async function run(argv: string[]): Promise<void> {
  const { options, args } = parseGlobal(argv);
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const client = createClient({ port: options.port });
  switch (command) {
    case "status": {
      const snapshot = await fetchSnapshot(client);
      const tabs = normalizeTabs(snapshot.state.tabs);
      const authProfiles = (snapshot.state.authProfiles as JsonRecord | undefined) ?? {};
      print({
        location: snapshot.location,
        status: snapshot.state.status,
        connection: snapshot.state.connection,
        waiting: snapshot.state.waiting,
        model: snapshot.state.model,
        activeTabId: snapshot.state.activeTabId,
        tabs: tabs.length,
        accounts: Array.isArray(authProfiles.profiles) ? authProfiles.profiles.length : 0,
      }, true);
      break;
    }
    case "state": {
      const path = args.shift() ?? "";
      const snapshot = await fetchSnapshot(client);
      print(jsonPointerGet(snapshot.state, path), true);
      break;
    }
    case "eval": {
      const js = readMessage(args);
      const result = await client.eval(js);
      print(result, options.json);
      break;
    }
    case "invoke": {
      const name = args.shift();
      if (!name) throw new Error("invoke requires a Tauri command name");
      const raw = args.length > 0 ? args.join(" ") : "{}";
      const parsed = JSON.parse(raw) as unknown;
      print(await client.invoke(name, parsed), true);
      break;
    }
    case "models": {
      const snapshot = await fetchSnapshot(client);
      const models = jsonPointerGet(snapshot.state, "/sidebar/models");
      print(models ?? [], true);
      break;
    }
    case "tabs": {
      await runTabs(client, args, options);
      break;
    }
    case "accounts": {
      await runAccounts(client, args, options);
      break;
    }
    case "chat": {
      await runChat(client, args, options);
      break;
    }
    case "agent": {
      await runAgent(client, args, options);
      break;
    }
    case "skills":
    case "skill": {
      runSkills(args, options);
      break;
    }
    case "wait": {
      const timeout = Number(optionValue(args, "--timeout") ?? "300000");
      print(await waitUntilIdle(client, timeout), true);
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function runTabs(
  client: ReturnType<typeof createClient>,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "list") {
    if (subcommand === "list") args.shift();
    const snapshot = await fetchSnapshot(client);
    print(normalizeTabs(snapshot.state.tabs), true);
    return;
  }
  args.shift();
  if (subcommand === "new") {
    const tab = await openAgentTab(client, {
      tabId: optionValue(args, "--id"),
      cwd: optionValue(args, "--cwd"),
      label: optionValue(args, "--label"),
      model: optionValue(args, "--model"),
      account: optionValue(args, "--account"),
    });
    print(tab, true);
    return;
  }
  if (subcommand === "close") {
    const tabId = args.shift();
    if (!tabId) throw new Error("tabs close requires a tab id");
    await closeAgentTab(client, tabId);
    print({ closed: tabId }, options.json);
    return;
  }
  throw new Error(`unknown tabs command: ${subcommand}`);
}

async function runAccounts(
  client: ReturnType<typeof createClient>,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args.shift() ?? "list";
  if (subcommand === "list") {
    const snapshot = await fetchSnapshot(client);
    print(jsonPointerGet(snapshot.state, "/authProfiles") ?? {}, true);
    return;
  }
  if (subcommand !== "use") throw new Error(`unknown accounts command: ${subcommand}`);
  const profileId = args.shift();
  if (!profileId) throw new Error("accounts use requires a profile id");
  const requestedTab = optionValue(args, "--tab") ?? "active";
  const snapshot = await fetchSnapshot(client);
  const target = activeTargetFromState(snapshot.state, requestedTab);
  const payloads = await applyAccountSwitch(client, profileId, target);
  print({ profileId, target, payloads }, options.json);
}

async function runChat(
  client: ReturnType<typeof createClient>,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args.shift();
  if (subcommand !== "send") throw new Error("usage: aethonctl chat send [options] <message>");
  const account = optionValue(args, "--account");
  const requestedTab = optionValue(args, "--tab") ?? "active";
  const cwd = optionValue(args, "--cwd");
  const model = optionValue(args, "--model");
  const thinkingLevel = optionValue(args, "--thinking-level");
  const planMode = optionFlag(args, "--plan");
  const wait = optionFlag(args, "--wait");
  const message = readMessage(args);
  const snapshot = await fetchSnapshot(client);
  const target = activeTargetFromState(snapshot.state, requestedTab);
  if (account) await applyAccountSwitch(client, account, target);
  await sendChat(client, message, {
    tabId: target.tabId,
    cwd: cwd ?? target.cwd,
    model: model ?? target.model,
    thinkingLevel,
    account,
    planMode,
  });
  const result: JsonRecord = { sent: true, tabId: target.tabId };
  if (account) result.account = account;
  if (wait) result.wait = await waitUntilIdle(client, 300_000);
  print(result, options.json);
}

async function runAgent(
  client: ReturnType<typeof createClient>,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args.shift() ?? "diagnostics";
  if (subcommand === "diagnostics" || subcommand === "diag") {
    print(await client.invoke("agent_diagnostics", {}), true);
    return;
  }
  if (subcommand === "command") {
    const raw = args.length > 0 ? args.join(" ") : readFileSync(0, "utf8");
    const payload = JSON.parse(raw) as unknown;
    const result = await client.eval(rawAgentCommandJs(payload));
    print(result || "ok", options.json);
    return;
  }
  if (subcommand === "stop") {
    const tabId = optionValue(args, "--tab") ?? "active";
    const snapshot = await fetchSnapshot(client);
    const target = activeTargetFromState(snapshot.state, tabId);
    await client.invoke("agent_command", { payload: JSON.stringify({ type: "stop", tabId: target.tabId }) });
    print({ stopped: true, tabId: target.tabId }, options.json);
    return;
  }
  throw new Error(`unknown agent command: ${subcommand}`);
}

function runSkills(args: string[], options: CliOptions): void {
  const subcommand = args.shift() ?? "show";
  if (subcommand === "show") {
    print(skillMarkdown(), false);
    return;
  }
  if (subcommand !== "install") throw new Error(`unknown skills command: ${subcommand}`);
  const project = optionFlag(args, "--project");
  const global = optionFlag(args, "--global");
  const force = optionFlag(args, "--force");
  const dir = optionValue(args, "--dir");
  if (project && global) throw new Error("--project and --global are mutually exclusive");
  const plan = planSkillInstall({ targets: args, project: project || !global ? project : false, dir });
  const written = installSkill(plan, force);
  print({ installed: written }, options.json);
}

function printHelp(): void {
  console.log(`aethonctl - control a running Aethon dev app

Usage:
  aethonctl status --json
  aethonctl state /authProfiles --json
  aethonctl tabs
  aethonctl tabs new --cwd /path/to/project --account <profile-id>
  aethonctl tabs close <tab-id>
  aethonctl models
  aethonctl accounts list
  aethonctl accounts use <profile-id> [--tab active|default|<id>]
  aethonctl chat send [--account <profile-id>] [--tab active|default|<id>] [--wait] <message>
  aethonctl agent diagnostics
  aethonctl agent command '{"type":"stop","tabId":"default"}'
  aethonctl invoke <tauri-command> [args-json]
  aethonctl eval 'return window.__AETHON_STATE__()'
  aethonctl skills show
  aethonctl skills install [claude|codex|agents|all] [--project|--global] [--dir PATH] [--force]

Global options:
  --json              Print JSON where applicable
  --port <port>       Override AETHON_DEBUG_PORT / ~/.aethon/dev-info.json
`);
}

run(process.argv.slice(2)).catch((err) => {
  console.error(`aethonctl: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
