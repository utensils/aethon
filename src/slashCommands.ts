// Client-side slash commands for Aethon's chat input. These run in the
// frontend without ever reaching the agent — useful for UI actions that
// don't need an LLM round-trip (clearing chat, switching theme, etc.).
//
// Pi's own server-side slash commands (extension/skill-registered ones
// like /clock, /reload) are not yet plumbed through the bridge — they'll
// arrive in a later phase that exposes pi's getCommands()/handler API.

export interface SlashCommandContext {
  /** Append a chat-history bubble (system role). Use for output that
   *  belongs in the conversation surface — `/help` listings, `/skills`
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
  listSkills: () => string[];
  listModels: () => { id: string; label: string; active?: boolean }[];
  toggleTerminal: () => void;
  // Show / hide / toggle the sidebar. State changes propagate via the
  // /layout/sidebarVisible / /layout/columns / /layout/areas $refs the
  // default layout binds to.
  toggleSidebar: () => void;
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
      name: "reset",
      description: "Reset the layout to the default",
      run: (_args, ctx) => {
        ctx.resetLayout();
        ctx.notify({ title: "Layout reset", kind: "success" });
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
      name: "layout",
      description: "Switch layout by id, or list available layouts",
      usage: "[id]",
      argSource: "/layoutCatalogue",
      run: (args, ctx) => {
        const v = args.trim();
        const layouts = ctx.listLayouts();
        if (!v) {
          const list = layouts
            .map((l) => `- \`${l.id}\` — ${l.name}${l.description ? ` (${l.description})` : ""}`)
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
      name: "skills",
      description: "List registered skills",
      run: (_args, ctx) => {
        const list = ctx.listSkills();
        ctx.appendSystem(
          list.length > 0
            ? `Registered skills:\n${list.map((s) => `- ${s}`).join("\n")}`
            : "No skills registered.",
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
// Returns null when the input is plain text (or starts with `//`, an escape
// for sending a literal slash to the agent).
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = trimmed.match(/^\/([A-Za-z][\w-]*)\s*(.*)$/s);
  if (!match) return null;
  return { name: match[1], args: match[2] ?? "" };
}
