// Client-side slash commands for Aethon's chat input. These run in the
// frontend without ever reaching the agent — useful for UI actions that
// don't need an LLM round-trip (clearing chat, switching theme, etc.).
//
// Pi's own server-side slash commands (extension commands, prompt templates,
// and skill commands like /skill:name) are hydrated from the bridge as
// passthrough entries. Submitting one sends the original text to pi's prompt
// router.

import { invoke } from "@tauri-apps/api/core";
import {
  formatTaskStatus,
  parseLoopArgs,
  type ScheduledTaskMode,
  type ScheduledTaskRecord,
  type ScheduledTaskSchedule,
} from "./scheduledTasks";
import type { AskUserAnswer, AskUserInput } from "./questions";

export interface SlashCommandContext {
  /** Append a chat-history bubble (system role). Use for output that
   *  belongs in the conversation surface — `/help` listings, `/extensions`
   *  output, etc. Don't use for transient mutation feedback (use
   *  `notify` instead so the chat doesn't fill with bookkeeping). */
  appendSystem: (text: string) => void;
  /** Push a toast notification. Use for transient mutation feedback
   *  ("Theme set to Paper.", "Layout switched."). Auto-dismisses after
   *  4s by default; pass `durationMs: null` to make it sticky. */
  notify: (input: {
    title: string;
    message?: string;
    kind?: "info" | "success" | "warning" | "error";
    durationMs?: number | null;
  }) => void;
  /** Ask the user an inline question in chat and resolve with the selected
   *  answer. Setup flows use this instead of modal prompts. */
  askUser?: (input: AskUserInput) => Promise<AskUserAnswer>;
  /** Active agent tab project root; prefers the tab cwd over the sidebar's
   *  active project so restored sessions operate on the right repo. */
  activeProjectRoot?: () => string | null;
  clearChat: () => void;
  // Switch the active theme by id. The three built-in palettes
  // (`ember`, `paper`, `aether`) are always available; extension-registered
  // themes appear here too once they've been hydrated from the bridge's
  // `extension_themes` event.
  setTheme: (id: string) => void;
  listThemes: () => { id: string; label: string }[];
  setModel: (id: string) => Promise<void>;
  setPlanMode?: (enabled: boolean) => void;
  getPlanMode?: () => boolean;
  resetLayout: () => void;
  listExtensions: () => string[];
  installExtension: (spec: string) => Promise<string>;
  listModels: () => { id: string; label: string; active?: boolean }[];
  openLogin: () => void;
  listAuthProfiles: () => {
    id: string;
    label: string;
    providerId: string;
    kind: "oauth" | "api_key";
    active?: boolean;
    default?: boolean;
  }[];
  useAuthProfile: (idOrLabel: string) => Promise<void>;
  setDefaultAuthProfile: (idOrLabel: string) => Promise<void>;
  toggleTerminal: () => void;
  // Show / hide / toggle the sidebar. State changes propagate via the
  // /layout/sidebarVisible / /layout/columns / /layout/areas $refs the
  // default layout binds to.
  toggleSidebar: () => void;
  // Show / hide / toggle the right-hand files sidebar. Same template-swap
  // semantics as toggleSidebar.
  toggleFilesSidebar: () => void;
  // Swap to a registered layout by id. Returns true on success. Use
  // listLayouts() to discover available ids.
  activateLayout: (id: string) => boolean;
  listLayouts: () => { id: string; name: string; description?: string }[];
  // Projects — directories the agent works in. Used by /project.
  // `pickProject` opens a native folder dialog; the others are
  // synchronous since the projects list is in-memory.
  pickProject: () => Promise<string | null>;
  openProject: (path: string, label?: string) => string;
  setActiveProject: (id: string) => boolean;
  clearProject: () => void;
  removeProject: (id: string) => boolean;
  listProjects: () => { id: string; label: string; path: string }[];
  activeProject: () => { id: string; label: string; path: string } | null;
  /** Hard-reload the agent bridge subprocess. Goes through the same
   *  supervisor path as the right-click "Disable extension" toggle:
   *  the new bridge re-discovers extensions, themes, slash commands,
   *  re-reads disabled-extensions.json, and emits a fresh `ready`. */
  reloadAgent: () => Promise<void>;
  /** Run a pi-native command implemented by the bridge for the active tab.
   *  Used for commands that pi's SDK does not execute through prompt()
   *  because they normally belong to the interactive TUI command loop. */
  runNativeCommand: (name: string, args: string) => Promise<void>;
  /** Rename a session by tabId. Empty `label` clears the custom label
   *  and falls back to the auto-derived first-user-message label. */
  renameSession: (tabId: string, label: string) => Promise<void>;
  openScheduledTasks?: () => void;
  createScheduledTask?: (input: {
    mode: ScheduledTaskMode;
    schedule: ScheduledTaskSchedule;
    prompt: string;
    label?: string;
    promptSource?: string;
  }) => Promise<ScheduledTaskRecord>;
  listScheduledTasks?: () => Promise<ScheduledTaskRecord[]>;
  runScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  pauseScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  resumeScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  reuseScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  cancelScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  deleteScheduledTask?: (id: string) => Promise<ScheduledTaskRecord>;
  /** Currently active tab id, or null when none. Used by `/rename` so
   *  no-arg target inference can hit the right session. */
  activeTabId: () => string | null;
}

/** A single completion option for a slash command's argument. The picker
 *  shows `label` (or `value`) and inserts `value` into the composer. */
export interface SlashArgOption {
  value: string;
  label?: string;
  description?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  /** Listed for autocomplete only. When submitted, the text is forwarded
   *  to the agent so pi can run its own skill / command router. */
  passthroughToAgent?: boolean;
  /** JSON Pointer into App state. When set, typing `/<name> <prefix>`
   *  surfaces the array at this path as completions. The shape is
   *  `SlashArgOption[]` OR a sidebar-item style array (any object with
   *  `id` + optional `label` is converted on the fly). Built-in
   *  `/theme` points at `/sidebar/themes`; `/layout` points at
   *  `/layoutCatalogue`. Extensions register their own pointer — this
   *  is the same `$ref` mechanism the rest of the app uses for state
   *  binding, so completion data can live anywhere in the tree. */
  argSource?: string;
  run: (args: string, ctx: SlashCommandContext) => Promise<void> | void;
}

function helpFor(commands: SlashCommand[]): string {
  const lines = ["Available slash commands:"];
  for (const c of commands) {
    const usage = c.usage ? `\`/${c.name} ${c.usage}\`` : `\`/${c.name}\``;
    lines.push(`- ${usage} — ${c.description}`);
  }
  return lines.join("\n");
}

function matchTask(
  tasks: ScheduledTaskRecord[],
  idOrPrefix: string,
): ScheduledTaskRecord | null {
  const needle = idOrPrefix.trim();
  if (!needle) return null;
  const exact = tasks.find((t) => t.id === needle);
  if (exact) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(needle));
  return matches.length === 1 ? matches[0] : null;
}

interface McpStatus {
  root: string;
  fingerprint?: string | null;
  state: string;
  required: boolean;
  approved: boolean;
  enabled: boolean;
  projectConfigMode: string;
  sources: { kind: string; relativePath: string; path: string }[];
}

interface SetupStatus {
  root: string;
  agents: { exists: boolean; path: string; managedBlock: boolean };
  startup: { exists: boolean; path: string };
  mcpToml: { exists: boolean; path: string };
  claudeMcpJson: { exists: boolean; path: string };
}

function requireProjectRoot(ctx: SlashCommandContext): string | null {
  const root = ctx.activeProjectRoot?.() ?? ctx.activeProject()?.path ?? null;
  if (!root) {
    ctx.notify({
      title: "No project selected",
      message: "Open a project or use a project-backed tab first.",
      kind: "warning",
    });
    return null;
  }
  return root;
}

async function askInline(
  ctx: SlashCommandContext,
  input: AskUserInput,
): Promise<AskUserAnswer | null> {
  if (!ctx.askUser) {
    ctx.notify({
      title: "Questions unavailable",
      message: "This command needs Aethon's inline question UI.",
      kind: "error",
    });
    return null;
  }
  return await ctx.askUser(input);
}

function defaultAgentsBody(root: string): string {
  const name = root.split("/").filter(Boolean).at(-1) ?? "this project";
  return [
    "# Aethon Project Notes",
    "",
    `This repository is opened in Aethon as \`${name}\`.`,
    "",
    "- Use the active project root as the working directory.",
    "- Preserve existing user changes unless explicitly asked to replace them.",
    "- Prefer focused checks that match the files you changed, then run the broader project gate when appropriate.",
  ].join("\n");
}

function mcpStatusText(status: McpStatus): string {
  const sources =
    status.sources.length > 0
      ? status.sources.map((s) => `\`${s.relativePath}\``).join(", ")
      : "none";
  return [
    `Project: \`${status.root}\``,
    `State: ${status.state}`,
    `Host enabled: ${status.enabled ? "yes" : "no"}`,
    `Project policy: ${status.projectConfigMode}`,
    `Sources: ${sources}`,
  ].join("\n");
}

async function readMcpStatus(root: string): Promise<McpStatus> {
  return await invoke<McpStatus>("mcp_config_status", { root });
}

async function readSetupStatus(root: string): Promise<SetupStatus> {
  return await invoke<SetupStatus>("aethon_setup_status", { root });
}

async function runInitCommand(ctx: SlashCommandContext): Promise<void> {
  const root = requireProjectRoot(ctx);
  if (!root) return;
  const status = await readSetupStatus(root);
  const answer = await askInline(ctx, {
    title: "Initialize project",
    prompt: status.agents.exists
      ? "`AGENTS.md` already exists. Aethon can add or refresh only its managed block."
      : "Create `AGENTS.md` with Aethon project guidance?",
    choices: [
      {
        id: "write",
        label: status.agents.exists ? "Update AGENTS.md" : "Create AGENTS.md",
        description: "Preserves everything outside the Aethon managed block.",
      },
      { id: "cancel", label: "Cancel" },
    ],
  });
  if (!answer) return;
  if (answer.choiceId !== "write") return;
  const result = await invoke<{ path: string }>("aethon_setup_write_agents", {
    args: { root, body: defaultAgentsBody(root) },
  });
  ctx.notify({
    title: "Project initialized",
    message: result.path,
    kind: "success",
  });
  ctx.appendSystem(`Updated \`${result.path}\`.`);
}

async function ensureMcpHostPolicy(): Promise<void> {
  await invoke("aethon_setup_set_host_mcp_policy", {
    args: { enabled: true, projectConfigs: "require-approval" },
  });
}

async function approveMcpProject(root: string, status: McpStatus): Promise<void> {
  if (!status.fingerprint) return;
  await invoke("mcp_config_approve", {
    root,
    fingerprint: status.fingerprint,
  });
}

async function runMcpCommand(
  ctx: SlashCommandContext,
  args: string,
): Promise<void> {
  const root = requireProjectRoot(ctx);
  if (!root) return;
  const setup = await readSetupStatus(root);
  const status = await readMcpStatus(root);
  const subcommand = args.trim().toLowerCase();
  const wantsStatus = subcommand === "status";
  const wantsSetup = subcommand === "" || subcommand === "setup";
  if (wantsStatus) {
    ctx.appendSystem(`## MCP\n${mcpStatusText(status)}`);
    return;
  }
  if (!wantsSetup) {
    ctx.notify({
      title: `Unknown MCP command: ${args.trim()}`,
      message: "Usage: /mcp [status|setup]",
      kind: "error",
    });
    return;
  }
  const choices = [
    ...(status.state === "approval_required"
      ? [
          {
            id: "approve",
            label: "Approve current config",
            description:
              "Trust the detected project MCP files for this fingerprint.",
          },
        ]
      : []),
    ...(setup.claudeMcpJson.exists
      ? [
          {
            id: "use-json",
            label: "Use .mcp.json directly",
            description: "Keep Claude Code format as the project source of truth.",
          },
          {
            id: "import",
            label: "Import to Aethon TOML",
            description: "Copy supported servers into `.aethon/mcp.toml`.",
          },
        ]
      : []),
    {
      id: "host-policy",
      label: "Enable host MCP",
      description:
        "Create or update `~/.aethon/config.toml` with approval-required policy.",
    },
    { id: "status", label: "Show status" },
  ];
  const answer = await askInline(ctx, {
    title: "MCP setup",
    prompt: mcpStatusText(status),
    choices,
  });
  if (!answer) return;
  switch (answer.choiceId) {
    case "approve": {
      await ensureMcpHostPolicy();
      await approveMcpProject(root, status);
      ctx.notify({ title: "MCP config approved", kind: "success" });
      ctx.appendSystem(
        "MCP project config approved. Run `/reload` to reload the agent bridge.",
      );
      return;
    }
    case "use-json": {
      await ensureMcpHostPolicy();
      const next = await readMcpStatus(root);
      await approveMcpProject(root, next);
      ctx.notify({ title: "Using .mcp.json", kind: "success" });
      ctx.appendSystem(
        "Aethon will use `.mcp.json` directly for this project. Run `/reload` to reload the agent bridge.",
      );
      return;
    }
    case "import": {
      await ensureMcpHostPolicy();
      const result = await invoke<{ path: string }>(
        "aethon_setup_import_mcp_json",
        { root },
      );
      const next = await readMcpStatus(root);
      await approveMcpProject(root, next);
      ctx.notify({
        title: "MCP imported",
        message: result.path,
        kind: "success",
      });
      ctx.appendSystem(
        `Imported MCP servers to \`${result.path}\`. Run \`/reload\` to reload the agent bridge.`,
      );
      return;
    }
    case "host-policy": {
      await ensureMcpHostPolicy();
      ctx.notify({ title: "Host MCP enabled", kind: "success" });
      ctx.appendSystem("Host MCP policy set to `require-approval`.");
      return;
    }
    default:
      ctx.appendSystem(`## MCP\n${mcpStatusText(status)}`);
  }
}

async function runStartupSetup(ctx: SlashCommandContext): Promise<void> {
  const root = requireProjectRoot(ctx);
  if (!root) return;
  const command = await askInline(ctx, {
    title: "Startup command",
    prompt: "Choose a startup command to add to `.aethon/startup.toml`.",
    allowText: true,
    choices: [
      { id: "bun-install", label: "bun install" },
      { id: "bun-dev", label: "bun run dev" },
      { id: "none", label: "Cancel" },
    ],
  });
  if (!command) return;
  if (command.choiceId === "none") return;
  const commandText =
    command.text?.trim() ||
    (command.choiceId === "bun-dev" ? "bun run dev" : "bun install");
  const required = await askInline(ctx, {
    title: "Startup command",
    prompt: `Should \`${commandText}\` be required before opening new project sessions?`,
    choices: [
      { id: "required", label: "Required" },
      { id: "optional", label: "Optional" },
    ],
  });
  if (!required) return;
  const result = await invoke<{ path: string }>(
    "aethon_setup_write_startup_command",
    {
      args: {
        root,
        id: commandText.split(/\s+/).slice(0, 3).join("-"),
        label: commandText,
        command: commandText,
        required: required.choiceId !== "optional",
        timeoutSeconds: 600,
      },
    },
  );
  ctx.notify({
    title: "Startup configured",
    message: result.path,
    kind: "success",
  });
  ctx.appendSystem(`Updated \`${result.path}\`.`);
}

async function runConfigCommand(ctx: SlashCommandContext): Promise<void> {
  const answer = await askInline(ctx, {
    title: "Aethon config",
    prompt: "What would you like to configure for this project?",
    choices: [
      {
        id: "mcp",
        label: "MCP servers",
        description:
          "Use or import `.mcp.json`, approve project MCP, and enable host policy.",
      },
      {
        id: "startup",
        label: "Startup command",
        description: "Create or update `.aethon/startup.toml`.",
      },
      {
        id: "init",
        label: "Project instructions",
        description:
          "Create or update the Aethon managed block in `AGENTS.md`.",
      },
    ],
  });
  if (!answer) return;
  if (answer.choiceId === "mcp") return runMcpCommand(ctx, "setup");
  if (answer.choiceId === "startup") return runStartupSetup(ctx);
  if (answer.choiceId === "init") return runInitCommand(ctx);
}

export function buildBuiltinSlashCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [
    {
      name: "clear",
      description: "Clear chat history",
      run: (_args, ctx) => ctx.clearChat(),
    },
    {
      name: "theme",
      description: "Switch theme by id, or list available themes",
      usage: "[id]",
      argSource: "/sidebar/themes",
      run: (args, ctx) => {
        const v = args.trim();
        const themes = ctx.listThemes();
        if (!v) {
          const list = themes.map((t) => `- ${t.id} — ${t.label}`).join("\n");
          ctx.appendSystem(
            themes.length > 0
              ? `Available themes:\n${list}`
              : "No themes registered.",
          );
          return;
        }
        const match = themes.find((t) => t.id === v);
        if (!match) {
          ctx.notify({
            title: `Unknown theme: ${v}`,
            message:
              themes.length > 0
                ? `Try: ${themes.map((t) => t.id).join(", ")}`
                : undefined,
            kind: "error",
          });
          return;
        }
        ctx.setTheme(match.id);
        ctx.notify({ title: `Theme: ${match.label}`, kind: "success" });
      },
    },
    {
      name: "model",
      description: "Switch active model by id",
      usage: "[provider/model-id]",
      argSource: "/sidebar/models",
      run: async (args, ctx) => {
        const id = args.trim();
        if (!id) {
          const list = ctx
            .listModels()
            .map((m) => `- ${m.active ? "● " : "  "}${m.id}`)
            .join("\n");
          ctx.appendSystem(`Available models:\n${list || "(none)"}`);
          return;
        }
        await ctx.setModel(id);
      },
    },
    {
      name: "plan",
      description: "Toggle planning-only mode for the active session",
      usage: "[on|off|toggle|status]",
      run: (args, ctx) => {
        if (!ctx.setPlanMode || !ctx.getPlanMode) {
          ctx.notify({
            title: "Plan mode unavailable",
            kind: "warning",
          });
          return;
        }
        const sub = args.trim().toLowerCase();
        const current = ctx.getPlanMode();
        if (!sub || sub === "toggle") {
          const enabled = !current;
          ctx.setPlanMode(enabled);
          ctx.notify({
            title: enabled ? "Plan mode on" : "Implementation mode on",
            message: enabled
              ? "New prompts will ask for a plan before code changes."
              : "New prompts may make code changes.",
            kind: "success",
          });
          return;
        }
        if (sub === "on" || sub === "true") {
          ctx.setPlanMode(true);
          ctx.notify({
            title: "Plan mode on",
            message: "New prompts will ask for a plan before code changes.",
            kind: "success",
          });
          return;
        }
        if (sub === "off" || sub === "false") {
          ctx.setPlanMode(false);
          ctx.notify({
            title: "Implementation mode on",
            message: "New prompts may make code changes.",
            kind: "success",
          });
          return;
        }
        if (sub === "status") {
          ctx.appendSystem(
            current
              ? "Plan mode is on for this session."
              : "Implementation mode is on for this session.",
          );
          return;
        }
        ctx.notify({
          title: `Unknown plan command: ${sub}`,
          message: "Usage: /plan [on|off|toggle|status]",
          kind: "error",
        });
      },
    },
    {
      name: "init",
      description: "Create or update project instructions for Aethon",
      run: async (_args, ctx) => runInitCommand(ctx),
    },
    {
      name: "config",
      description: "Open guided project configuration",
      run: async (_args, ctx) => runConfigCommand(ctx),
    },
    {
      name: "mcp",
      description: "Configure MCP servers for the active project",
      usage: "[status|setup]",
      run: async (args, ctx) => runMcpCommand(ctx, args),
    },
    {
      name: "mcp-auth",
      description: "Configure MCP authentication for the active project",
      run: async (_args, ctx) => runMcpCommand(ctx, "setup"),
    },
    {
      name: "login",
      description: "Manage stored provider accounts",
      usage: "[list|use <account>|default <account>]",
      run: async (args, ctx) => {
        const [subcommand, ...rest] = args.trim().split(/\s+/);
        const target = rest.join(" ").trim();
        if (!subcommand) {
          ctx.openLogin();
          return;
        }
        if (subcommand === "list") {
          const profiles = ctx.listAuthProfiles();
          const list = profiles
            .map((p) => {
              const flags = [
                p.active ? "active" : "",
                p.default ? "default" : "",
              ].filter(Boolean);
              return `- \`${p.id}\` — ${p.label} (${p.providerId}, ${p.kind}${flags.length ? `, ${flags.join(", ")}` : ""})`;
            })
            .join("\n");
          ctx.appendSystem(
            profiles.length > 0
              ? `Stored accounts:\n${list}`
              : "No stored accounts yet. Run `/login` to add one.",
          );
          return;
        }
        if (subcommand === "use") {
          if (!target) {
            ctx.notify({
              title: "Missing account",
              message: "Usage: /login use <account>",
              kind: "error",
            });
            return;
          }
          await ctx.useAuthProfile(target);
          return;
        }
        if (subcommand === "default") {
          if (!target) {
            ctx.notify({
              title: "Missing account",
              message: "Usage: /login default <account>",
              kind: "error",
            });
            return;
          }
          await ctx.setDefaultAuthProfile(target);
          return;
        }
        ctx.notify({
          title: `Unknown login command: ${subcommand}`,
          message: "Usage: /login [list|use <account>|default <account>]",
          kind: "error",
        });
      },
    },
    {
      name: "reset",
      description: "Reset the layout to the default",
      run: (_args, ctx) => {
        ctx.resetLayout();
        ctx.notify({ title: "Layout reset", kind: "success" });
      },
    },
    {
      name: "reload",
      description:
        "Reload the agent bridge — re-discover extensions, themes, and slash commands",
      run: async (_args, ctx) => {
        ctx.notify({
          title: "Reloading agent…",
          kind: "info",
        });
        try {
          await ctx.reloadAgent();
        } catch (err) {
          ctx.notify({
            title: "Reload failed",
            message: String(err),
            kind: "error",
          });
        }
      },
    },
    {
      name: "rename",
      description:
        "Rename the active session (empty input restores the auto-label)",
      usage: "[new label]",
      run: async (args, ctx) => {
        const tabId = ctx.activeTabId();
        if (!tabId) {
          ctx.notify({
            title: "No active session",
            kind: "warning",
          });
          return;
        }
        const label = args.trim();
        try {
          await ctx.renameSession(tabId, label);
          ctx.notify({
            title: label ? `Renamed to “${label}”` : "Restored default label",
            kind: "success",
          });
        } catch (err) {
          ctx.notify({
            title: "Rename failed",
            message: String(err),
            kind: "error",
          });
        }
      },
    },
    {
      name: "memory",
      description: "Show Aethon's user and resolved-project memory",
      run: (args, ctx) => ctx.runNativeCommand("memory", args),
    },
    {
      name: "context",
      description: "Show current pi context window usage",
      run: (args, ctx) => ctx.runNativeCommand("context", args),
    },
    {
      name: "session",
      description: "Show current pi session stats",
      run: (args, ctx) => ctx.runNativeCommand("session", args),
    },
    {
      name: "compact",
      description: "Compact older context using pi's compaction flow",
      usage: "[instructions]",
      run: (args, ctx) => ctx.runNativeCommand("compact", args),
    },
    {
      name: "name",
      description: "Show or set the pi session display name",
      usage: "[name]",
      run: (args, ctx) => ctx.runNativeCommand("name", args),
    },
    {
      name: "export",
      description:
        "Export the pi session as HTML, or JSONL when path ends in .jsonl",
      usage: "[path.html|path.jsonl]",
      run: (args, ctx) => ctx.runNativeCommand("export", args),
    },
    {
      name: "loop",
      description: "Run a repeated scheduled task in this session",
      usage: "[interval] [prompt] | reuse <id>",
      run: async (args, ctx) => {
        if (!args.trim()) {
          ctx.openScheduledTasks?.();
          ctx.appendSystem(
            "No loop scheduled. Use `/loop <prompt>` for a self-paced loop, `/loop <interval> <prompt>` for a fixed loop, `/loop reuse <id>` to adopt an existing loop here, or create one from Scheduled Tasks.",
          );
          return;
        }
        const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const sub = subRaw?.toLowerCase();
        if (sub === "reuse" || sub === "adopt") {
          try {
            if (!ctx.listScheduledTasks || !ctx.reuseScheduledTask) {
              throw new Error("Scheduled tasks are unavailable.");
            }
            const task = matchTask(await ctx.listScheduledTasks(), rest[0] ?? "");
            if (!task) {
              ctx.notify({
                title: "Unknown loop",
                message: "Use `/tasks list` to find the id.",
                kind: "error",
              });
              return;
            }
            const updated = await ctx.reuseScheduledTask(task.id);
            ctx.notify({
              title: "Loop reused here",
              message: updated.label,
              kind: "success",
            });
            ctx.appendSystem(
              `Loop reused on this session: ${updated.label}\nTask: \`${updated.id.slice(0, 8)}\`\nStatus: ${formatTaskStatus(updated)}`,
            );
          } catch (err) {
            ctx.notify({
              title: "Loop reuse failed",
              message: err instanceof Error ? err.message : String(err),
              kind: "error",
            });
          }
          return;
        }
        const parsed = parseLoopArgs(args);
        if (!parsed.ok) {
          ctx.notify({
            title: "Invalid loop",
            message: parsed.error,
            kind: "error",
          });
          return;
        }
        try {
          if (!ctx.createScheduledTask) {
            throw new Error("Scheduled tasks are unavailable.");
          }
          const task = await ctx.createScheduledTask({
            mode: parsed.mode,
            schedule: parsed.schedule,
            prompt: parsed.prompt,
          });
          const cadence =
            task.mode === "loopFixed" && task.schedule.kind === "interval"
              ? `every ${task.schedule.label}`
              : "self-paced";
          ctx.notify({
            title: "Loop scheduled",
            message: `${task.label} (${task.id.slice(0, 8)})`,
            kind: "success",
          });
          ctx.appendSystem(
            `Loop scheduled (${cadence}): ${task.label}\nPrompt: ${task.visiblePrompt}`,
          );
        } catch (err) {
          ctx.notify({
            title: "Loop failed",
            message: err instanceof Error ? err.message : String(err),
            kind: "error",
          });
        }
      },
    },
    {
      name: "tasks",
      description: "Open or control Scheduled Tasks",
      usage: "[list|run|pause|resume|cancel|delete <id>]",
      run: async (args, ctx) => {
        const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const sub = subRaw?.toLowerCase();
        if (!sub || sub === "open") {
          if (ctx.openScheduledTasks) ctx.openScheduledTasks();
          else {
            ctx.notify({
              title: "Scheduled tasks unavailable",
              kind: "warning",
            });
          }
          return;
        }
        if (!ctx.listScheduledTasks) {
          ctx.notify({
            title: "Scheduled tasks unavailable",
            kind: "warning",
          });
          return;
        }
        if (sub === "list") {
          const tasks = await ctx.listScheduledTasks();
          if (tasks.length === 0) {
            ctx.appendSystem("No scheduled tasks.");
            return;
          }
          ctx.appendSystem(
            [
              "Scheduled tasks:",
              ...tasks.map(
                (task) =>
                  `- \`${task.id.slice(0, 8)}\` — ${task.label} (${formatTaskStatus(task)})`,
              ),
            ].join("\n"),
          );
          return;
        }
        const id = rest[0] ?? "";
        const tasks = await ctx.listScheduledTasks();
        const task = matchTask(tasks, id);
        if (!task) {
          ctx.notify({
            title: "Unknown task",
            message: "Use `/tasks list` to find the id.",
            kind: "error",
          });
          return;
        }
        const action =
          sub === "run"
            ? ctx.runScheduledTask
            : sub === "pause"
              ? ctx.pauseScheduledTask
              : sub === "resume"
                ? ctx.resumeScheduledTask
                : sub === "delete"
                  ? ctx.deleteScheduledTask
                  : sub === "cancel" || sub === "stop"
                    ? ctx.cancelScheduledTask
                    : null;
        if (!action) {
          ctx.notify({
            title: `Unknown tasks command: ${sub}`,
            message: "Usage: /tasks [list|run|pause|resume|cancel|delete <id>]",
            kind: "error",
          });
          return;
        }
        const updated = await action(task.id);
        const deleted = sub === "delete";
        ctx.notify({
          title: deleted ? "Task deleted" : `Task ${updated.status}`,
          message: updated.label,
          kind: !deleted && updated.status === "failed" ? "error" : "success",
        });
      },
    },
    {
      name: "terminal",
      description: "Toggle the terminal panel",
      run: (_args, ctx) => ctx.toggleTerminal(),
    },
    {
      name: "sidebar",
      description: "Toggle the sidebar",
      run: (_args, ctx) => ctx.toggleSidebar(),
    },
    {
      name: "files",
      description: "Toggle the right-hand files sidebar",
      run: (_args, ctx) => ctx.toggleFilesSidebar(),
    },
    {
      name: "layout",
      description: "Switch layout by id, or list available layouts",
      usage: "[id]",
      argSource: "/layoutCatalogue",
      run: (args, ctx) => {
        const v = args.trim();
        const layouts = ctx.listLayouts();
        if (!v) {
          const list = layouts
            .map(
              (l) =>
                `- \`${l.id}\` — ${l.name}${l.description ? ` (${l.description})` : ""}`,
            )
            .join("\n");
          ctx.appendSystem(
            layouts.length > 0
              ? `Available layouts:\n${list}`
              : "No layouts registered.",
          );
          return;
        }
        const ok = ctx.activateLayout(v);
        if (ok) {
          ctx.notify({ title: `Layout: ${v}`, kind: "success" });
        } else {
          ctx.notify({
            title: `Unknown layout: ${v}`,
            message:
              layouts.length > 0
                ? `Try: ${layouts.map((l) => l.id).join(", ")}`
                : undefined,
            kind: "error",
          });
        }
      },
    },
    {
      name: "extensions",
      description:
        "List registered extensions, or install an Aethon extension package",
      usage: "[install <npm-package|git-url>]",
      run: async (args, ctx) => {
        const v = args.trim();
        const [subcommand, ...rest] = v.split(/\s+/);
        if (subcommand === "install" || subcommand === "add") {
          const spec = rest.join(" ").trim();
          if (!spec) {
            ctx.notify({
              title: "Missing extension package",
              message: "Usage: /extensions install <npm-package|git-url>",
              kind: "error",
            });
            return;
          }
          ctx.notify({
            title: "Installing extension",
            message: spec,
            kind: "info",
            durationMs: null,
          });
          const output = await ctx.installExtension(spec);
          ctx.appendSystem(
            `Extension install complete: \`${spec}\`\n\n${output || "Agent will reload on next request."}`,
          );
          return;
        }
        if (v) {
          ctx.notify({
            title: `Unknown extensions command: ${subcommand}`,
            message: "Usage: /extensions install <npm-package|git-url>",
            kind: "error",
          });
          return;
        }
        const list = ctx.listExtensions();
        ctx.appendSystem(
          list.length > 0
            ? `Registered extensions:\n${list.map((s) => `- ${s}`).join("\n")}`
            : "No extensions registered.",
        );
      },
    },
    {
      name: "project",
      description:
        "Open or switch the active project directory. No arg → folder picker; id/path → switch.",
      usage: "[id|path]",
      argSource: "/sidebar/projects",
      run: async (args, ctx) => {
        const v = args.trim();
        const projects = ctx.listProjects();
        if (!v) {
          // No arg: pop the native picker. On cancel, list current
          // projects so the user discovers what's already known
          // without an extra round-trip.
          const path = await ctx.pickProject();
          if (path) {
            const active = ctx.activeProject();
            ctx.notify({
              title: `Project: ${active?.label ?? path}`,
              message: path,
              kind: "success",
            });
            return;
          }
          if (projects.length === 0) {
            ctx.notify({ title: "No projects yet", kind: "info" });
            return;
          }
          // Listing belongs in chat so the user can scroll back to it.
          const list = projects
            .map((p) => `- \`${p.id}\` — ${p.label} (${p.path})`)
            .join("\n");
          ctx.appendSystem(`Known projects:\n${list}`);
          return;
        }
        // Treat the arg as either a project id (sidebar selection) or a
        // raw path. id wins to keep parity with the picker selection.
        const byId = projects.find((p) => p.id === v);
        if (byId) {
          ctx.setActiveProject(byId.id);
          ctx.notify({
            title: `Project: ${byId.label}`,
            message: byId.path,
            kind: "success",
          });
          return;
        }
        // Plausible path? Accept anything starting with `/` or `~` so we
        // don't silently miss-classify a typo as a path. The runtime
        // code expanding `~` happens in the bridge.
        if (v.startsWith("/") || v.startsWith("~")) {
          ctx.openProject(v);
          ctx.notify({ title: `Project: ${v}`, kind: "success" });
          return;
        }
        ctx.notify({
          title: `Unknown project: ${v}`,
          message:
            projects.length > 0
              ? `Try: ${projects.map((p) => p.id).join(", ")}`
              : undefined,
          kind: "error",
        });
      },
    },
  ];

  commands.push({
    name: "help",
    description: "Show available slash commands",
    run: (_args, ctx) => ctx.appendSystem(helpFor(commands)),
  });

  return commands;
}

export interface ParsedSlashCommand {
  name: string;
  args: string;
}

// Parse a chat input line into a slash command if it starts with `/word`.
// Pi skill commands use a single colon segment (`/skill:name`), and pi may
// suffix duplicate extension commands (`/review:1`), so the command name
// grammar accepts one optional `:<segment>` suffix.
// Returns null when the input is plain text (or starts with `//`, an escape
// for sending a literal slash to the agent).
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = trimmed.match(
    /^\/([A-Za-z][\w-]*(?::[A-Za-z0-9][\w-]*)?)\s*(.*)$/s,
  );
  if (!match) return null;
  const name = match[1];
  const args = match[2] ?? "";
  const numberedMcp = name.match(/^(mcp|mcp-auth):(\d+)$/);
  if (numberedMcp) {
    return {
      name: numberedMcp[1],
      args: [numberedMcp[2], args].filter(Boolean).join(" ").trim(),
    };
  }
  return { name, args };
}
