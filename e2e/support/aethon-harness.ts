import type { Page } from "@playwright/test";

export const PROJECT_ROOT = "/repo/aethon";
export const AETHON_ROOT = "/home/test/.aethon";
export const DEFAULT_MODEL = "openai-codex/gpt-5.5";
export const ALT_MODEL = "ollama-localhost/qwen3.6:35b-a3b-coding-nvfp4";

type InvokeCall = {
  cmd: string;
  args: Record<string, unknown>;
};

type FsEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  modified: number;
};

type AethonE2eState = {
  activeTabId?: string;
  connection?: string;
  status?: string;
  waiting?: boolean;
  queueCount?: number;
  model?: string;
  defaultModel?: string;
  sidebar?: {
    models?: { id: string; active?: boolean }[];
  };
  tabs?: { id: string; model?: string }[];
};

type TauriCallback = (event: unknown) => void;

type TauriInternals = {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  transformCallback: (callback: TauriCallback) => number;
  unregisterCallback: (id: number) => void;
  runCallback: (id: number, data: unknown) => void;
  callbacks: Map<number, TauriCallback>;
  convertFileSrc: (filePath: string) => string;
};

declare global {
  interface Window {
    __AETHON_STATE__?: () => AethonE2eState;
    __TAURI_INTERNALS__?: TauriInternals;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (_event: string, id: number) => void;
    };
    __AETHON_E2E__?: {
      calls: InvokeCall[];
      emit: (event: string, payload: unknown) => void;
      emitAgent: (message: Record<string, unknown>) => void;
      completeActiveTurn: () => void;
      failNextSendMessage: () => void;
      setDir: (root: string, path: string, entries: FsEntry[]) => void;
      getCalls: () => InvokeCall[];
      clearCalls: () => void;
    };
  }
}

export async function installAethonHarness(page: Page): Promise<void> {
  await page.addInitScript(
    ({ projectRoot, aethonRoot, defaultModel, altModel }) => {
      type Callback = (event: unknown) => void;
      type Listener = { event: string; callbackId: number };
      type Entry = {
        name: string;
        path: string;
        kind: "file" | "dir";
        size: number;
        modified: number;
      };

      const calls: { cmd: string; args: Record<string, unknown> }[] = [];
      const callbacks = new Map<number, Callback>();
      const listeners = new Map<number, Listener>();
      const files = new Map<string, Entry[]>();
      const stateFiles = new Map<string, string>();
      let nextCallbackId = 1;
      let nextListenerId = 1;
      let model = defaultModel;
      const promptStateByTab = new Map<
        string,
        { inFlight: boolean; queued: number }
      >();
      let failNextSend = false;

      const key = (root: string, path: string) => `${root}\u0000${path}`;
      const stringArg = (value: unknown, fallback = ""): string =>
        typeof value === "string" ? value : fallback;
      const entry = (
        name: string,
        path: string,
        kind: "file" | "dir",
      ): Entry => ({
        name,
        path,
        kind,
        size: kind === "file" ? 42 : 0,
        modified: 1,
      });

      files.set(key(projectRoot, projectRoot), [
        entry("agent", `${projectRoot}/agent`, "dir"),
        entry("src", `${projectRoot}/src`, "dir"),
        entry("src-tauri", `${projectRoot}/src-tauri`, "dir"),
        entry("package.json", `${projectRoot}/package.json`, "file"),
        entry("README.md", `${projectRoot}/README.md`, "file"),
      ]);
      files.set(key(projectRoot, `${projectRoot}/src`), [
        entry("App.tsx", `${projectRoot}/src/App.tsx`, "file"),
        entry("main.tsx", `${projectRoot}/src/main.tsx`, "file"),
      ]);
      files.set(key(aethonRoot, aethonRoot), [
        entry("extensions", `${aethonRoot}/extensions`, "dir"),
        entry("sessions", `${aethonRoot}/sessions`, "dir"),
        entry("config.toml", `${aethonRoot}/config.toml`, "file"),
      ]);

      stateFiles.set(
        "projects.json",
        JSON.stringify({
          schemaVersion: 3,
          activeId: "project-aethon",
          activeWorktreeId: null,
          activeHostId: "local:test",
          projects: [
            {
              id: "project-aethon",
              label: "aethon",
              path: projectRoot,
              lastUsed: 1,
              uiExpanded: true,
              hostId: "local:test",
            },
          ],
          worktreesByProject: {
            "project-aethon": [
              {
                id: "wt-main",
                projectId: "project-aethon",
                label: "main",
                branch: "main",
                path: projectRoot,
                isMain: true,
              },
            ],
          },
        }),
      );

      const ready = () => ({
        type: "ready",
        model,
        projectRoot,
        userDir: aethonRoot,
        models: [
          { id: defaultModel, label: "GPT-5.5" },
          { id: altModel, label: "qwen3.6:35b-a3b-coding-nvfp4" },
        ],
        tabs: [],
        discoveredTabs: [],
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

      const emit = (event: string, payload: unknown) => {
        for (const [id, listener] of listeners) {
          if (listener.event !== event) continue;
          callbacks.get(listener.callbackId)?.({ id, event, payload });
        }
      };
      const emitAgent = (message: Record<string, unknown>) => {
        emit("agent-response", JSON.stringify(message));
      };

      const setDir = (root: string, path: string, entries: Entry[]) => {
        files.set(key(root, path), entries);
      };
      const promptState = (tabId: string) => {
        const existing = promptStateByTab.get(tabId);
        if (existing) return existing;
        const next = { inFlight: false, queued: 0 };
        promptStateByTab.set(tabId, next);
        return next;
      };
      const completeActiveTurn = () => {
        const state = window.__AETHON_STATE__?.();
        const tabId = state?.activeTabId ?? "default";
        const turn = promptState(tabId);
        if (!turn.inFlight) return;
        emitAgent({ type: "response_end", tabId });
        if (turn.queued > 0) {
          turn.queued -= 1;
          queueMicrotask(() =>
            emitAgent({
              type: "prompt_started",
              tabId,
              source: "queue",
              queued: turn.queued,
            }),
          );
          return;
        }
        turn.inFlight = false;
      };

      const invoke = (async (cmd: string, rawArgs?: unknown) => {
        await Promise.resolve();
        const args =
          rawArgs && typeof rawArgs === "object"
            ? (rawArgs as Record<string, unknown>)
            : {};
        calls.push({ cmd, args });

        if (cmd === "plugin:event|listen") {
          const id = nextListenerId++;
          listeners.set(id, {
            event: String(args.event),
            callbackId: Number(args.handler),
          });
          return id;
        }
        if (cmd === "plugin:event|unlisten") {
          listeners.delete(Number(args.eventId));
          return undefined;
        }
        if (cmd === "plugin:event|emit") {
          emit(String(args.event), args.payload);
          return undefined;
        }

        switch (cmd) {
          case "read_config":
            return {
              ui: {
                theme: "ember",
                fontSize: null,
                restoreTabs: false,
                notifyOnCompletion: false,
                notifyMinDurationSeconds: 8,
              },
              agent: { model: defaultModel },
              shell: {
                defaultShareMode: "private",
                autoRestartAgent: true,
                defaultCommand: null,
                defaultArgs: [],
                inheritEnv: true,
                promptBeforeClose: true,
              },
              shortcuts: { newTabKind: "agent" },
            };
          case "read_state":
            return stateFiles.get(stringArg(args.name)) ?? "";
          case "write_state":
            stateFiles.set(stringArg(args.name), stringArg(args.content));
            return undefined;
          case "host_info":
            return {
              id: "local:test",
              hostname: "halcyon",
              displayName: "halcyon",
              fingerprint: "test",
            };
          case "aethon_home_dir":
            return aethonRoot;
          case "git_status":
            return { branch: "main", dirty: false, ahead: 0, behind: 0 };
          case "git_worktrees":
            return [
              {
                id: "wt-main",
                label: "main",
                branch: "main",
                path: projectRoot,
                active: true,
                isMain: true,
              },
            ];
          case "gh_repo_overview":
            return {
              ghAvailable: true,
              repo: "utensils/aethon",
              description: "Aethon e2e harness repository",
              url: "https://github.com/example/aethon",
              defaultBranch: "main",
              stargazerCount: 0,
              forkCount: 0,
              openIssuesCount: 0,
              openPrsCount: 0,
              pushedAt: "2026-05-24T00:00:00Z",
            };
          case "gh_issue_list":
            return [];
          case "gh_branch_status":
            return {
              branch: "main",
              defaultBranch: "main",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              pullRequest: null,
            };
          case "fs_list_dir": {
            const root = stringArg(args.root);
            const path = stringArg(args.path);
            return files.get(key(root, path)) ?? [];
          }
          case "fs_watch_dirs":
          case "fs_unwatch_root":
          case "watch_project_extensions":
          case "unwatch_project_extensions":
          case "set_extension_menu_items":
          case "start_agent":
            return undefined;
          case "agent_command": {
            const parsed: unknown = JSON.parse(stringArg(args.payload, "{}"));
            const payload =
              parsed && typeof parsed === "object"
                ? (parsed as {
                    type?: string;
                    tabId?: string;
                    id?: string;
                    name?: string;
                    args?: string;
                  })
                : {};
            if (payload.type === "report") {
              queueMicrotask(() => emitAgent(ready()));
            }
            if (payload.type === "set_model" && payload.id) {
              model = payload.id;
              queueMicrotask(() =>
                emitAgent({
                  type: "model_changed",
                  tabId: payload.tabId ?? "default",
                  model,
                }),
              );
            }
            if (payload.type === "native_slash_command") {
              queueMicrotask(() =>
                emitAgent({
                  type: "native_slash_result",
                  tabId: payload.tabId ?? "default",
                  command: payload.name,
                  message:
                    payload.name === "context"
                      ? `## Context\n- Model: ${model}\n- Window: 272,000 tokens`
                      : `${payload.name ?? "command"} ok`,
                }),
              );
            }
            return undefined;
          }
          case "send_message": {
            if (failNextSend) {
              failNextSend = false;
              throw new Error("e2e send failure");
            }
            const request =
              args.request && typeof args.request === "object"
                ? (args.request as Record<string, unknown>)
                : args;
            const tabId = stringArg(request.tabId, "default");
            const mode = stringArg(request.mode, "normal");
            const turn = promptState(tabId);
            if (mode === "steer" && turn.inFlight) {
              return undefined;
            }
            if (mode === "normal" && turn.inFlight) {
              turn.queued += 1;
              queueMicrotask(() => emitAgent({ type: "queued", tabId }));
              return undefined;
            }
            turn.inFlight = true;
            queueMicrotask(() =>
              emitAgent({ type: "prompt_started", tabId, queued: 0 }),
            );
            return undefined;
          }
          case "updater_available":
            return false;
          default:
            return undefined;
        }
      }) satisfies TauriInternals["invoke"];

      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        invoke,
        transformCallback(callback: Callback) {
          const id = nextCallbackId++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        runCallback(id: number, data: unknown) {
          callbacks.get(id)?.(data);
        },
        callbacks,
        convertFileSrc(filePath: string) {
          return `asset://localhost/${encodeURIComponent(filePath)}`;
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(_event: string, id: number) {
          listeners.delete(id);
        },
      };
      window.__AETHON_E2E__ = {
        calls,
        emit,
        emitAgent,
        completeActiveTurn,
        failNextSendMessage: () => {
          failNextSend = true;
        },
        setDir,
        getCalls: () => calls.slice(),
        clearCalls: () => {
          calls.length = 0;
        },
      };
    },
    {
      projectRoot: PROJECT_ROOT,
      aethonRoot: AETHON_ROOT,
      defaultModel: DEFAULT_MODEL,
      altModel: ALT_MODEL,
    },
  );
}

export async function waitForAethonReady(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    const state = window.__AETHON_STATE__?.();
    return state?.connection === "connected" && state?.status === "ready";
  });
}

export async function getInvokeCalls(page: Page): Promise<InvokeCall[]> {
  return page.evaluate(() => window.__AETHON_E2E__?.getCalls() ?? []);
}
