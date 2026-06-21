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
import { AethonControlClient } from "./controlClient.ts";

interface CliOptions {
  json: boolean;
  port?: number;
  socket?: string;
  transport: "auto" | "control" | "debug";
}

/** Default `--wait` / `wait` ceiling. Agent turns routinely run for minutes, so
 *  the old 5-minute default reported false timeouts on long turns; this is the
 *  ceiling, not a fixed delay — a `--wait` returns the instant the turn ends. */
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

function print(value: unknown, json = false): void {
  if (json || typeof value !== "string") {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

function parseGlobal(argv: string[]): { options: CliOptions; args: string[] } {
  const options: CliOptions = { json: false, transport: "auto" };
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--port") {
      const next = argv[++i];
      if (!next) throw new Error("--port requires a value");
      options.port = Number(next);
    } else if (arg === "--socket") {
      const next = argv[++i];
      if (!next) throw new Error("--socket requires a value");
      options.socket = next;
    } else if (arg === "--transport") {
      const next = argv[++i];
      if (next !== "auto" && next !== "control" && next !== "debug") {
        throw new Error("--transport must be auto, control, or debug");
      }
      options.transport = next;
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

  const client = createRuntime(options);
  switch (command) {
    case "status": {
      if (client.kind === "control") {
        print(await client.control.request("status"), true);
      } else {
        const snapshot = await fetchSnapshot(client.debug);
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
          transport: "debug",
        }, true);
      }
      break;
    }
    case "state": {
      requireDebug(client, "state");
      const path = args.shift() ?? "";
      const snapshot = await fetchSnapshot(client.debug);
      print(jsonPointerGet(snapshot.state, path), true);
      break;
    }
    case "eval": {
      requireDebug(client, "eval");
      const js = readMessage(args);
      const result = await client.debug.eval(js);
      print(result, options.json);
      break;
    }
    case "invoke": {
      requireDebug(client, "invoke");
      const name = args.shift();
      if (!name) throw new Error("invoke requires a Tauri command name");
      const raw = args.length > 0 ? args.join(" ") : "{}";
      const parsed = JSON.parse(raw) as unknown;
      print(await client.debug.invoke(name, parsed), true);
      break;
    }
    case "models": {
      if (client.kind === "control") {
        print(await client.control.request("models.list"), true);
      } else {
        const snapshot = await fetchSnapshot(client.debug);
        const models = jsonPointerGet(snapshot.state, "/sidebar/models");
        print(models ?? [], true);
      }
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
      const timeout = Number(optionValue(args, "--timeout") ?? String(DEFAULT_WAIT_MS));
      if (client.kind === "control") {
        print(await client.control.request("chat.wait", { timeoutMs: timeout }), true);
      } else {
        print(await waitUntilIdle(client.debug, timeout), true);
      }
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

type RuntimeClient =
  | { kind: "control"; control: AethonControlClient }
  | { kind: "debug"; debug: ReturnType<typeof createClient> };

function createRuntime(options: CliOptions): RuntimeClient {
  if (options.transport === "debug") {
    return { kind: "debug", debug: createClient({ port: options.port }) };
  }
  if (options.transport === "control") {
    return { kind: "control", control: new AethonControlClient({ socketPath: options.socket }) };
  }
  try {
    return { kind: "control", control: new AethonControlClient({ socketPath: options.socket }) };
  } catch (err) {
    if (options.socket) throw err;
    return { kind: "debug", debug: createClient({ port: options.port }) };
  }
}

function requireDebug(
  client: RuntimeClient,
  command: string,
): asserts client is { kind: "debug"; debug: ReturnType<typeof createClient> } {
  if (client.kind !== "debug") {
    throw new Error(`${command} is debug-only; pass --transport debug to use the dev bridge`);
  }
}

async function runTabs(
  client: RuntimeClient,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "list") {
    if (subcommand === "list") args.shift();
    if (client.kind === "control") {
      print(await client.control.request("tabs.list"), true);
    } else {
      const snapshot = await fetchSnapshot(client.debug);
      print(normalizeTabs(snapshot.state.tabs), true);
    }
    return;
  }
  args.shift();
  if (subcommand === "new") {
    const tab = client.kind === "control"
      ? await client.control.request("tabs.open", {
          tabId: optionValue(args, "--id"),
          cwd: optionValue(args, "--cwd"),
          label: optionValue(args, "--label"),
          model: optionValue(args, "--model"),
          account: optionValue(args, "--account"),
        })
      : await openAgentTab(client.debug, {
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
    if (client.kind === "control") {
      await client.control.request("tabs.close", { tabId });
    } else {
      await closeAgentTab(client.debug, tabId);
    }
    print({ closed: tabId }, options.json);
    return;
  }
  throw new Error(`unknown tabs command: ${subcommand}`);
}

async function runAccounts(
  client: RuntimeClient,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args.shift() ?? "list";
  if (subcommand === "list") {
    if (client.kind === "control") {
      print(await client.control.request("accounts.list"), true);
    } else {
      const snapshot = await fetchSnapshot(client.debug);
      print(jsonPointerGet(snapshot.state, "/authProfiles") ?? {}, true);
    }
    return;
  }
  if (subcommand !== "use") throw new Error(`unknown accounts command: ${subcommand}`);
  const profileId = args.shift();
  if (!profileId) throw new Error("accounts use requires a profile id");
  const requestedTab = optionValue(args, "--tab") ?? "active";
  if (client.kind === "control") {
    print(await client.control.request("accounts.use", { profileId, tabId: requestedTab }), options.json);
  } else {
    const snapshot = await fetchSnapshot(client.debug);
    const target = activeTargetFromState(snapshot.state, requestedTab);
    const payloads = await applyAccountSwitch(client.debug, profileId, target);
    print({ profileId, target, payloads }, options.json);
  }
}

async function runChat(
  client: RuntimeClient,
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
  const waitTimeoutMs = Number(optionValue(args, "--timeout") ?? String(DEFAULT_WAIT_MS));
  const message = readMessage(args);
  if (client.kind === "control") {
    let targetTab = requestedTab;
    if ((cwd || model) && requestedTab === "active") {
      const opened = await client.control.request<JsonRecord>("tabs.open", {
        cwd,
        model,
        account,
        label: "CLI",
      });
      targetTab = typeof opened.id === "string" ? opened.id : targetTab;
    }
    print(
      await client.control.request("chat.send", {
        message,
        tabId: targetTab,
        ...(account ? { account } : {}),
        ...(wait ? { wait: true, timeoutMs: waitTimeoutMs } : {}),
        ...(planMode ? { planMode } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      }),
      options.json,
    );
  } else {
    const snapshot = await fetchSnapshot(client.debug);
    const target = activeTargetFromState(snapshot.state, requestedTab);
    if (account) await applyAccountSwitch(client.debug, account, target);
    await sendChat(client.debug, message, {
      tabId: target.tabId,
      cwd: cwd ?? target.cwd,
      model: model ?? target.model,
      thinkingLevel,
      account,
      planMode,
    });
    const result: JsonRecord = { sent: true, tabId: target.tabId };
    if (account) result.account = account;
    if (wait) result.wait = await waitUntilIdle(client.debug, waitTimeoutMs);
    print(result, options.json);
  }
}

async function runAgent(
  client: RuntimeClient,
  args: string[],
  options: CliOptions,
): Promise<void> {
  const subcommand = args.shift() ?? "diagnostics";
  if (subcommand === "diagnostics" || subcommand === "diag") {
    if (client.kind === "control") {
      throw new Error("agent diagnostics is not on the release transport yet; use --transport debug");
    }
    print(await client.debug.invoke("agent_diagnostics", {}), true);
    return;
  }
  if (subcommand === "command") {
    requireDebug(client, "agent command");
    const raw = args.length > 0 ? args.join(" ") : readFileSync(0, "utf8");
    const payload = JSON.parse(raw) as unknown;
    const result = await client.debug.eval(rawAgentCommandJs(payload));
    print(result || "ok", options.json);
    return;
  }
  if (subcommand === "stop") {
    const tabId = optionValue(args, "--tab") ?? "active";
    if (client.kind === "control") {
      print(await client.control.request("agent.stop", { tabId }), options.json);
    } else {
      const snapshot = await fetchSnapshot(client.debug);
      const target = activeTargetFromState(snapshot.state, tabId);
      await client.debug.invoke("agent_command", { payload: JSON.stringify({ type: "stop", tabId: target.tabId }) });
      print({ stopped: true, tabId: target.tabId }, options.json);
    }
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
  const plan = planSkillInstall({ targets: args, project, dir });
  const written = installSkill(plan, force);
  print({ installed: written }, options.json);
}

function printHelp(): void {
  console.log(`aethonctl - control a running Aethon app

Usage:
  aethonctl status --json
  aethonctl tabs
  aethonctl tabs new --cwd /path/to/project --account <profile-id>
  aethonctl tabs close <tab-id>
  aethonctl models
  aethonctl accounts list
  aethonctl accounts use <profile-id> [--tab active|default|<id>]
  aethonctl chat send [--account <profile-id>] [--tab active|default|<id>] [--wait] [--timeout <ms>] [--plan] [--thinking-level <level>] <message>
  aethonctl agent stop [--tab active|default|<id>]
  aethonctl skills show
  aethonctl skills install [claude|codex|agents|all] [--project|--global] [--dir PATH] [--force]

Debug-only:
  aethonctl --transport debug state /authProfiles --json
  aethonctl --transport debug agent diagnostics
  aethonctl --transport debug invoke <tauri-command> [args-json]
  aethonctl --transport debug eval 'return window.__AETHON_STATE__()'

Global options:
  --json              Print JSON where applicable
  --transport <mode>  auto | control | debug (default: auto)
  --socket <path>     Override ~/.aethon/control/control.json socket path
  --port <port>       Debug transport only: override AETHON_DEBUG_PORT / ~/.aethon/dev-info.json
`);
}

run(process.argv.slice(2)).catch((err) => {
  console.error(`aethonctl: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
