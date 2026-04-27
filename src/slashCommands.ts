// Client-side slash commands for Aethon's chat input. These run in the
// frontend without ever reaching the agent — useful for UI actions that
// don't need an LLM round-trip (clearing chat, switching theme, etc.).
//
// Pi's own server-side slash commands (extension/skill-registered ones
// like /clock, /reload) are not yet plumbed through the bridge — they'll
// arrive in a later phase that exposes pi's getCommands()/handler API.

export interface SlashCommandContext {
  appendSystem: (text: string) => void;
  clearChat: () => void;
  // Switch the active theme by id. "dark"/"light" are always available;
  // extension-registered themes appear here too once they've been
  // hydrated from the bridge's `extension_themes` event.
  setTheme: (id: string) => void;
  listThemes: () => { id: string; label: string }[];
  setModel: (id: string) => Promise<void>;
  resetLayout: () => void;
  listSkills: () => string[];
  listModels: () => { id: string; label: string; active?: boolean }[];
  toggleTerminal: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
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
          ctx.appendSystem(
            `Unknown theme: \`${v}\`. Try one of: ${
              themes.map((t) => t.id).join(", ") || "(none)"
            }`,
          );
          return;
        }
        ctx.setTheme(match.id);
        ctx.appendSystem(`Theme set to ${match.label}.`);
      },
    },
    {
      name: "model",
      description: "Switch active model by id",
      usage: "[provider/model-id]",
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
        ctx.appendSystem("Layout reset to default.");
      },
    },
    {
      name: "terminal",
      description: "Toggle the terminal panel",
      run: (_args, ctx) => ctx.toggleTerminal(),
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
