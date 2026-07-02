// Fake remote-gateway for the mobile browser loop and e2e: a Bun
// WebSocket server speaking wire protocol v1 (hello/invoke/sub →
// hello_ok/result/event) with the same fixture data the desktop e2e
// harness injects. Lets the reused App boot over `?gateway=` with zero
// desktop instance — deterministic data for rendering work.
//
//   bun e2e/support/fake-gateway.ts [--port 8765]
//
// Unknown invokes resolve `ok:true, data:null` and are logged, so a
// missing fixture shows up in the console instead of wedging the UI.

type Frame = Record<string, unknown>;

// Minimal Bun.serve surface — the repo doesn't carry @types/bun, and
// this file only runs under `bun` (never bundled or imported).
interface GatewaySocket {
  send: (text: string) => void;
}
declare const Bun: {
  serve(options: {
    port: number;
    fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | undefined;
    websocket: {
      open(ws: GatewaySocket): void;
      close(ws: GatewaySocket): void;
      message(ws: GatewaySocket, raw: string | Uint8Array): void;
    };
  }): unknown;
};

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8765);

const MODEL = "openai/gpt-5.5";
const PROJECT_ROOT = "/Users/tester/projects/aethon";

const ready = () => ({
  type: "ready",
  model: MODEL,
  projectRoot: PROJECT_ROOT,
  userDir: "/Users/tester/.aethon",
  currentProjectCwd: PROJECT_ROOT,
  models: [
    { id: MODEL, label: "GPT-5.5" },
    { id: "ollama/qwen3.6:35b", label: "qwen3.6:35b" },
  ],
  tabs: [{ id: "default", model: MODEL, cwd: PROJECT_ROOT }],
  discoveredTabs: [
    {
      tabId: "default",
      title: "polish chat activity",
      cwd: PROJECT_ROOT,
      updatedAt: 1782960000000,
      messageCount: 24,
    },
    {
      tabId: "tab-fix-ci",
      title: "fix nightly CI gate",
      cwd: PROJECT_ROOT,
      updatedAt: 1782950000000,
      messageCount: 9,
    },
  ],
  extensionsList: [],
  failedExtensionsList: [],
  disabledExtensionsList: [],
  extensionComponents: {},
  extensionState: {},
  extensionStateKeys: [],
  extensionLayoutPatches: [],
  extensionThemes: [],
  extensionSlashCommands: [],
  extensionKeybindings: [],
  extensionEventRoutes: [],
  extensionLayouts: [],
  extensionFrontendModules: [],
  piSlashCommands: [],
});

const PROJECTS_STATE = JSON.stringify({
  schemaVersion: 5,
  activeProjectId: "project-aethon",
  projects: [
    {
      id: "project-aethon",
      label: "aethon",
      path: PROJECT_ROOT,
      lastUsed: 1,
      uiExpanded: true,
      hostId: "local:test",
    },
  ],
  workspacesByProject: {
    "project-aethon": [
      {
        id: "wt-main",
        projectId: "project-aethon",
        label: "main",
        branch: "main",
        path: PROJECT_ROOT,
        isMain: true,
      },
    ],
  },
});

const CONFIG = {
  ui: {
    theme: "ember",
    fontSize: null,
    restoreTabs: false,
    notifyOnCompletion: false,
    notifyMinDurationSeconds: 8,
  },
  agent: { model: MODEL },
  shell: {
    defaultShareMode: "private",
    autoRestartAgent: true,
    defaultCommand: null,
    defaultArgs: [],
    inheritEnv: true,
    promptBeforeClose: true,
  },
  voice: {
    toggleHotkey: "mod+shift+m",
    holdHotkey: null,
    speakAgentReplies: false,
    speakMaxChars: 600,
    conversationContinuous: false,
  },
  shortcuts: { newTabKind: "agent" },
};

const FILES: Record<string, unknown[]> = {
  "": [
    { name: "src", isDir: true },
    { name: "src-tauri", isDir: true },
    { name: "docs", isDir: true },
    { name: "README.md", isDir: false, size: 4096 },
    { name: "package.json", isDir: false, size: 2048 },
  ],
  src: [
    { name: "App.tsx", isDir: false, size: 9000 },
    { name: "main.tsx", isDir: false, size: 1200 },
  ],
};

function invokeResult(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case "read_config":
      return CONFIG;
    case "read_state":
      return args.name === "projects" ? PROJECTS_STATE : "";
    case "host_info":
      return { id: "local:test", hostname: "halcyon", displayName: "halcyon", fingerprint: "test" };
    case "aethon_home_dir":
      return "/Users/tester/.aethon";
    case "git_status":
      return { branch: "main", dirty: true, ahead: 1, behind: 0 };
    case "git_file_status":
      return {
        files: [
          { path: "src/App.tsx", status: "modified", staged: false },
          { path: "docs/mobile.md", status: "added", staged: true },
        ],
      };
    case "fs_list_dir":
      return FILES[typeof args.path === "string" ? args.path : ""] ?? [];
    case "search_sessions":
      return [];
    case "diagnostics":
      return { ok: true };
    case "subagents_list":
      return [];
    case "scheduled_tasks_list":
      return [];
    case "gh_branch_status":
    case "gh_checks":
    case "gh_repo_overview":
      return null;
    default:
      return null;
  }
}

type Client = { ws: GatewaySocket; topics: Set<string>; seq: number };
const clients = new Set<Client>();

function pushEvent(client: Client, topic: string, payload: unknown) {
  if (!client.topics.has(topic)) return;
  client.seq += 1;
  client.ws.send(JSON.stringify({ t: "event", topic, seq: client.seq, payload }));
}

function emitAgent(client: Client, message: Record<string, unknown>) {
  pushEvent(client, "agent-response", JSON.stringify(message));
}

function streamTurn(client: Client, tabId: string) {
  emitAgent(client, { type: "prompt_started", tabId, queued: 0 });
  const chunks = [
    "Sure — here's a **markdown** reply with some `inline code`,\n\n",
    "```ts\nconst x: number = 42;\nexport function demo() {\n  return x * 2;\n}\n```\n\n",
    "- a list item\n- another item with a [link](https://example.com)\n\n",
    "and a closing paragraph long enough to wrap on a phone screen so we can check line measure, padding, and scroll behaviour.",
  ];
  let delay = 150;
  for (const chunk of chunks) {
    setTimeout(
      () =>
        emitAgent(client, {
          type: "response_delta",
          tabId,
          channel: "text",
          content: chunk,
        }),
      delay,
    );
    delay += 250;
  }
  setTimeout(() => emitAgent(client, { type: "response_end", tabId }), delay + 200);
}

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("fake-gateway: ws only", { status: 426 });
  },
  websocket: {
    open(ws) {
      clients.add({ ws, topics: new Set<string>(), seq: 0 });
    },
    close(ws) {
      for (const c of clients) if (c.ws === ws) clients.delete(c);
    },
    message(ws, raw) {
      const client = [...clients].find((c) => c.ws === ws);
      if (!client) return;
      let frame: Frame;
      try {
        frame = JSON.parse(String(raw)) as Frame;
      } catch {
        return;
      }
      switch (frame.t) {
        case "hello":
          ws.send(
            JSON.stringify({
              t: "hello_ok",
              protocol: 1,
              host: { displayName: "halcyon (fake)", fingerprint: "test" },
              deviceId: "dev-fake",
              appVersion: "0.0.0-fake",
            }),
          );
          break;
        case "sub":
          for (const topic of (frame.topics as string[] | undefined) ?? []) {
            client.topics.add(topic);
          }
          break;
        case "unsub":
          for (const topic of (frame.topics as string[] | undefined) ?? []) {
            client.topics.delete(topic);
          }
          break;
        case "invoke": {
          const cmd = String(frame.cmd);
          const args = (frame.args ?? {}) as Record<string, unknown>;
          if (cmd === "start_agent") {
            ws.send(JSON.stringify({ t: "result", id: frame.id, ok: true, data: null }));
            setTimeout(() => emitAgent(client, ready()), 50);
            return;
          }
          if (cmd === "send_message") {
            ws.send(JSON.stringify({ t: "result", id: frame.id, ok: true, data: null }));
            streamTurn(client, typeof args.tabId === "string" ? args.tabId : "default");
            return;
          }
          const data = invokeResult(cmd, args);
          if (data === null && !(cmd in { gh_branch_status: 1, gh_checks: 1, gh_repo_overview: 1 })) {
            const detail = cmd === "agent_command" ? ` ${JSON.stringify(args).slice(0, 160)}` : "";
            console.log(`[fake-gateway] unfixtured invoke: ${cmd}${detail}`);
          }
          ws.send(JSON.stringify({ t: "result", id: frame.id, ok: true, data }));
          break;
        }
        default:
          break;
      }
    },
  },
});

console.log(`fake-gateway listening on ws://localhost:${port} (token: any)`);
