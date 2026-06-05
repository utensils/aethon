// Pi tool definitions wrapping `globalThis.aethon.tasks` +
// `globalThis.aethon.dashboard.*` so the model has UI parity with the
// per-project dashboard composer.
//
// Without these tool wrappers, the model would have to know to call
// `globalThis.aethon.tasks.start({...})` from inside a `bash` tool —
// not discoverable via tool catalogs. With these registered, the model
// sees `startTask` / `getRepoOverview` / `refreshDashboard` alongside
// the built-in tools and can drive the dashboard from a chat turn.
//
// Each tool is a thin shim: validate args, call the bridge API, return
// the result as a TextContent payload. The actual work (worktree
// create, tab spawn, gh shellout) happens frontend-side via the
// dashboard_query bridge message.

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

interface TasksApi {
  start(args: {
    projectPath: string;
    prompt: string;
    newWorktree?: boolean;
    branch?: string;
    baseBranch?: string;
    model?: string;
    bridgePrompt?: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

interface DashboardApi {
  getRepoOverview(args: {
    projectPath: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  refresh(args?: {
    projectPath?: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  listIssues(args: {
    projectPath: string;
    limit?: number;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  getIssue(args: {
    projectPath: string;
    number: number;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

function getApi(): { tasks: TasksApi; dashboard: DashboardApi } | null {
  const g = globalThis as {
    aethon?: { tasks?: TasksApi; dashboard?: DashboardApi };
  };
  if (!g.aethon?.tasks || !g.aethon?.dashboard) return null;
  return { tasks: g.aethon.tasks, dashboard: g.aethon.dashboard };
}

function fail(message: string): never {
  throw new Error(message);
}

const StartTaskParams = Type.Object({
  projectPath: Type.String({
    description:
      "Absolute filesystem path to the target project. Look in `aethon.listExtensions()` / runtime snapshot / your conversation context to find an open project's path.",
  }),
  prompt: Type.String({
    description:
      "The first chat message to send into the new tab. Same content the user would type into the task launcher; @file references are resolved in the launched tab's cwd.",
  }),
  newWorktree: Type.Optional(
    Type.Boolean({
      description:
        "When true, create a fresh git worktree off `baseBranch` (or the project's configured default, normally origin/main) and start the task in that cwd. When false / omitted, use the project root.",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description:
        "Name of the new branch to create. Required when `newWorktree` is true.",
    }),
  ),
  baseBranch: Type.Optional(
    Type.String({
      description:
        "Base branch to fork the new worktree from. Defaults to the project's configured worktree base when omitted.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional model id to use in the launched task tab, matching the dashboard model chip.",
    }),
  ),
  bridgePrompt: Type.Optional(
    Type.String({
      description:
        "Optional hidden bridge prompt to send to the launched tab; prompt remains the visible user text.",
    }),
  ),
});
type StartTaskParamsT = Static<typeof StartTaskParams>;

const RepoOverviewParams = Type.Object({
  projectPath: Type.String({
    description: "Absolute filesystem path to the project.",
  }),
});
type RepoOverviewParamsT = Static<typeof RepoOverviewParams>;

const RefreshParams = Type.Object({
  projectPath: Type.Optional(
    Type.String({
      description:
        "When set, only refresh the named project's gh cache. Omit to invalidate the next dashboard fetch globally.",
    }),
  ),
});
type RefreshParamsT = Static<typeof RefreshParams>;

const ListIssuesParams = Type.Object({
  projectPath: Type.String({
    description: "Absolute filesystem path to the project.",
  }),
  limit: Type.Optional(
    Type.Number({
      description:
        "Max issues to fetch. Clamped to [1, 100]. Defaults to 30 to match the dashboard surface.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});
type ListIssuesParamsT = Static<typeof ListIssuesParams>;

const GetIssueParams = Type.Object({
  projectPath: Type.String({
    description: "Absolute filesystem path to the project.",
  }),
  number: Type.Number({
    description: "Issue number, positive integer.",
    minimum: 1,
  }),
});
type GetIssueParamsT = Static<typeof GetIssueParams>;

export function buildDashboardTools(): ToolDefinition[] {
  const startTaskTool = defineTool({
    name: "startTask",
    label: "Start a task in a project",
    description:
      "Spawn a new agent tab in the named project (optionally creating a fresh git worktree first) and forward `prompt` as the tab's first user message. UI parity with the per-project dashboard's task launcher.",
    promptSnippet:
      "startTask: launch a new project task, optionally in a fresh worktree",
    parameters: StartTaskParams,
    async execute(_callId: string, params: StartTaskParamsT) {
      const api = getApi();
      if (!api) fail("aethon.tasks API unavailable");
      const r = await api.tasks.start({
        projectPath: params.projectPath,
        prompt: params.prompt,
        ...(typeof params.newWorktree === "boolean"
          ? { newWorktree: params.newWorktree }
          : {}),
        ...(typeof params.branch === "string" ? { branch: params.branch } : {}),
        ...(typeof params.baseBranch === "string"
          ? { baseBranch: params.baseBranch }
          : {}),
        ...(typeof params.model === "string" ? { model: params.model } : {}),
        ...(typeof params.bridgePrompt === "string"
          ? { bridgePrompt: params.bridgePrompt }
          : {}),
      });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(r.data ?? {}, null, 2) },
        ],
        details: r.data,
      };
    },
  }) as ToolDefinition;

  const repoOverviewTool = defineTool({
    name: "getRepoOverview",
    label: "Get GitHub repo overview",
    description:
      "Return cached gh repo data for a project (stars, forks, open issues, open PRs, default branch, last pushed). Five-minute live TTL with 30-minute negative-result TTL; this is the same data the project-dashboard's stats strip shows.",
    promptSnippet:
      "getRepoOverview: fetch cached GitHub repo metadata for a project",
    parameters: RepoOverviewParams,
    async execute(_callId: string, params: RepoOverviewParamsT) {
      const api = getApi();
      if (!api) fail("aethon.dashboard API unavailable");
      const r = await api.dashboard.getRepoOverview({
        projectPath: params.projectPath,
      });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(r.data ?? {}, null, 2) },
        ],
        details: r.data,
      };
    },
  }) as ToolDefinition;

  const refreshTool = defineTool({
    name: "refreshDashboard",
    label: "Refresh dashboard cache",
    description:
      "Invalidate the gh-repo-overview cache for one project (or all when projectPath is omitted). The next dashboard fetch shells out to gh fresh.",
    promptSnippet:
      "refreshDashboard: bust the gh overview cache after an external change",
    parameters: RefreshParams,
    async execute(_callId: string, params: RefreshParamsT) {
      const api = getApi();
      if (!api) fail("aethon.dashboard API unavailable");
      const r = await api.dashboard.refresh(
        typeof params.projectPath === "string"
          ? { projectPath: params.projectPath }
          : {},
      );
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: r.data ?? null,
      };
    },
  }) as ToolDefinition;

  const listIssuesTool = defineTool({
    name: "listOpenIssues",
    label: "List open GitHub issues",
    description:
      "Fetch open issues for the gh-resolved repository at projectPath. Cached for 90s; returns the same array the per-project dashboard's Issues section renders.",
    promptSnippet:
      "listOpenIssues: read the open issue list for a project",
    parameters: ListIssuesParams,
    async execute(_callId: string, params: ListIssuesParamsT) {
      const api = getApi();
      if (!api) fail("aethon.dashboard API unavailable");
      const r = await api.dashboard.listIssues({
        projectPath: params.projectPath,
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
      });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(r.data ?? {}, null, 2) },
        ],
        details: r.data,
      };
    },
  }) as ToolDefinition;

  const getIssueTool = defineTool({
    name: "getOpenIssue",
    label: "Fetch a single GitHub issue's body",
    description:
      "Return the full title + url + author + body for one open issue. Pair with `startTask` to launch a fresh worktree with the issue text as the first user message.",
    promptSnippet:
      "getOpenIssue: fetch the body of one GitHub issue by number",
    parameters: GetIssueParams,
    async execute(_callId: string, params: GetIssueParamsT) {
      const api = getApi();
      if (!api) fail("aethon.dashboard API unavailable");
      const r = await api.dashboard.getIssue({
        projectPath: params.projectPath,
        number: params.number,
      });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(r.data ?? {}, null, 2) },
        ],
        details: r.data,
      };
    },
  }) as ToolDefinition;

  return [
    startTaskTool,
    repoOverviewTool,
    refreshTool,
    listIssuesTool,
    getIssueTool,
  ];
}
