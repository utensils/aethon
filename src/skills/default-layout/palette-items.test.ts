import { describe, expect, it } from "vitest";
import {
  BUILTIN_KEYBINDINGS,
  fuzzyScore,
  rankItems,
  selectPaletteItems,
  type SelectInput,
} from "./palette-items";

const SAMPLE: SelectInput = {
  tabs: [
    { id: "default", label: "Tab 1" },
    { id: "abc-xyz", label: "Notes" },
  ],
  activeTabId: "default",
  recentSessions: [
    { id: "old-session", label: "Restored draft", lastModified: "yesterday" },
  ],
  sidebar: {
    projects: [{ id: "proj-1", label: "aethon" }],
    themes: [
      { id: "ember", label: "Ember", active: true },
      { id: "paper", label: "Paper" },
    ],
    layouts: [
      { id: "workstation", label: "workstation", active: true },
      { id: "live-layout", label: "live-layout" },
    ],
    models: [
      { id: "anthropic/claude", label: "Claude", active: true },
    ],
  },
  slashCommands: [
    { name: "clear", description: "Clear chat history" },
    { name: "theme", description: "Switch theme by id" },
  ],
  keybindings: [
    { combo: "ctrl+g", action: "git:gist", description: "Git gist" },
  ],
  layoutCatalogue: [
    { id: "workstation", label: "Workstation" },
    { id: "live-layout", label: "Live Layout" },
  ],
};

describe("selectPaletteItems", () => {
  it("switcher mode leads with tabs and includes every section", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    expect(items[0].section).toBe("tabs");
    const sections = new Set(items.map((i) => i.section));
    for (const s of [
      "tabs",
      "sessions",
      "projects",
      "commands",
      "layouts",
      "themes",
      "models",
      "keybindings",
    ]) {
      expect(sections.has(s as never)).toBe(true);
    }
  });

  it("commands mode leads with commands", () => {
    const items = selectPaletteItems(SAMPLE, "commands");
    expect(items[0].section).toBe("commands");
  });

  it("marks the active tab with hint=active", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    const active = items.find((i) => i.id === "tab:default");
    expect(active?.hint).toBe("active");
  });

  it("includes built-in keybindings before extension ones in the keybindings section", () => {
    const items = selectPaletteItems(SAMPLE, "commands");
    const keys = items.filter((i) => i.section === "keybindings");
    expect(keys[0].id.startsWith("keybind:builtin:")).toBe(true);
    expect(keys.some((k) => k.id === "keybind:ext:ctrl+g")).toBe(true);
    expect(keys.some((k) => k.id === "keybind:builtin:meta+k")).toBe(true);
    expect(keys.some((k) => k.id === "keybind:builtin:meta+.")).toBe(true);
    expect(keys.some((k) => k.id === "keybind:builtin:meta+shift+m")).toBe(true);
    // Built-in count matches the catalogue.
    const builtinCount = keys.filter((k) =>
      k.id.startsWith("keybind:builtin:"),
    ).length;
    expect(builtinCount).toBe(BUILTIN_KEYBINDINGS.length);
  });

  it("hides a built-in keybinding when an extension overrides the combo", () => {
    const items = selectPaletteItems(
      {
        ...SAMPLE,
        keybindings: [
          { combo: "meta+k", action: "custom-clear", description: "Custom clear" },
        ],
      },
      "commands",
    );
    const keys = items.filter((i) => i.section === "keybindings");
    expect(keys.some((k) => k.id === "keybind:builtin:meta+k")).toBe(false);
    expect(keys.some((k) => k.id === "keybind:ext:meta+k")).toBe(true);
  });

  it("always surfaces an Open Project… entry even with no projects", () => {
    const items = selectPaletteItems(
      { ...SAMPLE, sidebar: {} },
      "switcher",
    );
    expect(items.find((i) => i.id === "project:open")).toBeTruthy();
  });
});

describe("fuzzyScore", () => {
  it("scores empty query as a wildcard (>0)", () => {
    expect(fuzzyScore("", "anything")).toBeGreaterThan(0);
  });

  it("ranks an exact match highest", () => {
    expect(fuzzyScore("clear", "clear")).toBeGreaterThan(
      fuzzyScore("clear", "clearance"),
    );
  });

  it("ranks prefix matches above mid-string substring matches", () => {
    expect(fuzzyScore("term", "terminal")).toBeGreaterThan(
      fuzzyScore("term", "open terminal"),
    );
  });

  it("returns 0 when chars don't appear in order", () => {
    expect(fuzzyScore("xyz", "abcdef")).toBe(0);
  });

  it("matches as an in-order subsequence with gaps", () => {
    expect(fuzzyScore("trm", "terminal")).toBeGreaterThan(0);
  });
});

describe("rankItems", () => {
  it("returns items unchanged when query is blank", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    const ranked = rankItems(items, "");
    expect(ranked.length).toBe(items.length);
  });

  it("filters out non-matching items", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    const ranked = rankItems(items, "ember");
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => /e.*m.*b/i.test(`${r.label} ${r.hint ?? ""}`))).toBe(true);
  });

  it("`>` prefix biases commands above tabs", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    // Without prefix: a tab labelled "the" would beat a commands-section
    // match. With `>` prefix, commands jump to the top regardless.
    const ranked = rankItems(items, ">theme");
    expect(ranked[0].section).toBe("commands");
  });

  it("`@` prefix biases tabs above commands", () => {
    const items = selectPaletteItems(SAMPLE, "switcher");
    const ranked = rankItems(items, "@tab");
    expect(ranked[0].section).toBe("tabs");
  });

  it("typing 'theme' surfaces /theme + theme rows, NOT every slash command", () => {
    // Regression for the bug screenshot where typing "theme" listed
    // /reload, /model, /mcp-auth, /terminal, … because the old scorer
    // accepted any in-order subsequence match against the concatenated
    // label + hint + section haystack. Letters t-h-e-m-e occur in
    // order inside "Swi**t**c**h** activ**e** **m**od**e**l" so /model
    // matched. With substring-first scoring + word-boundary fuzzy
    // fallback, /model et al. score 0.
    const items = selectPaletteItems(
      {
        ...SAMPLE,
        slashCommands: [
          { name: "theme", description: "Switch theme by id" },
          { name: "reload", description: "Reload the agent bridge" },
          { name: "model", description: "Switch active model by id" },
          { name: "mcp-auth", description: "Authenticate with an MCP server" },
          { name: "terminal", description: "Toggle the terminal panel" },
        ],
      },
      "commands",
    );
    const ranked = rankItems(items, "theme");
    // First hit is the slash command itself.
    expect(ranked[0].id).toBe("slash:theme");
    // Every surviving row is genuinely theme-related: it has "theme"
    // somewhere in its label / hint / section, or it IS the /theme
    // command. /reload, /model, /mcp-auth, /terminal must NOT appear.
    const ids = ranked.map((r) => r.id);
    expect(ids).not.toContain("slash:reload");
    expect(ids).not.toContain("slash:model");
    expect(ids).not.toContain("slash:mcp-auth");
    expect(ids).not.toContain("slash:terminal");
  });

  it("typing a command name without the leading slash still matches it", () => {
    const items = selectPaletteItems(SAMPLE, "commands");
    expect(rankItems(items, "clear")[0].id).toBe("slash:clear");
    expect(rankItems(items, "/clear")[0].id).toBe("slash:clear");
  });
});
