// Client-side slash commands for Aethon's chat input. These run in the
// frontend without ever reaching the agent — useful for UI actions that
// don't need an LLM round-trip (clearing chat, switching theme, etc.).
//
// Pi's own server-side slash commands (extension commands, prompt templates,
// and skill commands like /skill:name) are hydrated from the bridge as
// passthrough entries. Submitting one sends the original text to pi's prompt
// router.

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
  clearChat: () => void;
  // Switch the active theme by id. The three built-in palettes
  // (`ember`, `paper`, `aether`) are always available; extension-registered
  // themes appear here too once they've been hydrated from the bridge's
  // `extension_themes` event.
  setTheme: (id: string) => void;
  listThemes: () => { id: string; label: string }[];
  setModel: (id: string) => Promise<void>;
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
      description: "Export the pi session as HTML, or JSONL when path ends in .jsonl",
      usage: "[path.html|path.jsonl]",
      run: (args, ctx) => ctx.runNativeCommand("export", args),
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
  return { name: match[1], args: match[2] ?? "" };
}
