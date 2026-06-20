// Pure helpers for the command palette — split out from
// command-palette.tsx so vitest tests can import them without a React
// runtime, and so react-refresh doesn't trip over a non-component
// export sharing the file with components.

export type PaletteMode = "switcher" | "commands" | "files";

export type PaletteSection =
  | "tabs"
  | "sessions"
  | "projects"
  | "commands"
  | "keybindings"
  | "layouts"
  | "themes"
  | "models"
  | "actions"
  | "files";

export const SECTION_LABEL: Record<PaletteSection, string> = {
  tabs: "Tabs",
  sessions: "Recent sessions",
  projects: "Projects",
  commands: "Slash commands",
  keybindings: "Keybindings",
  layouts: "Layouts",
  themes: "Themes",
  models: "Models",
  actions: "Actions",
  files: "Files",
};

export type PalettePayload =
  | { kind: "tab"; tabId: string }
  | { kind: "session"; sessionId: string; label: string; cwd?: string }
  | { kind: "project"; projectId: string }
  | { kind: "open-project" }
  | { kind: "slash"; name: string; args?: string }
  | { kind: "keybinding"; combo: string; action: string }
  | { kind: "layout"; layoutId: string }
  | { kind: "theme"; themeId: string }
  | { kind: "model"; modelId: string }
  | { kind: "action"; action: string }
  | { kind: "file"; filePath: string };

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  section: PaletteSection;
  shortcut?: string;
  payload: PalettePayload;
}

export interface BuiltinKeybinding {
  combo: string;
  description: string;
}

// Hardcoded built-in keybindings — kept in sync with the keydown handler
// in App.tsx. Surfaced in the palette so users can discover shortcuts
// without leaving the workspace.
export const BUILTIN_KEYBINDINGS: BuiltinKeybinding[] = [
  { combo: "meta+p", description: "Quick-open file (fuzzy search)" },
  { combo: "meta+shift+p", description: "Open command palette" },
  { combo: "shift+tab", description: "Toggle Plan mode" },
  { combo: "meta+t", description: "New tab (focus-aware)" },
  { combo: "meta+shift+t", description: "New shell sub-tab" },
  { combo: "meta+w", description: "Close active tab" },
  { combo: "meta+alt+t", description: "Reopen most-recently-closed tab" },
  { combo: "meta+shift+]", description: "Next tab" },
  { combo: "meta+shift+[", description: "Previous tab" },
  { combo: "meta+alt+]", description: "Move active tab right" },
  { combo: "meta+alt+[", description: "Move active tab left" },
  { combo: "meta+1", description: "Jump to tab 1" },
  { combo: "meta+2", description: "Jump to tab 2" },
  { combo: "meta+3", description: "Jump to tab 3" },
  { combo: "meta+4", description: "Jump to tab 4" },
  { combo: "meta+5", description: "Jump to tab 5" },
  { combo: "meta+6", description: "Jump to tab 6" },
  { combo: "meta+7", description: "Jump to tab 7" },
  { combo: "meta+8", description: "Jump to tab 8" },
  { combo: "meta+9", description: "Jump to last tab" },
  { combo: "ctrl+`", description: "Toggle terminal panel + focus" },
  { combo: "meta+j", description: "Toggle files panel" },
  {
    combo: "meta+0",
    description: "Toggle focus between composer and terminal",
  },
  { combo: "meta+l", description: "Focus active tab's input" },
  { combo: "meta+shift+l", description: "Open Scheduled Tasks" },
  { combo: "meta+b", description: "Toggle left sidebar (projects)" },
  { combo: "meta+d", description: "Toggle right sidebar (files)" },
  { combo: "meta+k", description: "Clear chat" },
  { combo: "meta+.", description: "Stop current prompt" },
  { combo: "meta+shift+m", description: "Toggle voice input" },
  { combo: "meta+=", description: "Zoom in" },
  { combo: "meta+-", description: "Zoom out" },
  { combo: "meta+shift+0", description: "Reset zoom" },
  { combo: "meta+shift+s", description: "Export chat as Markdown" },
  { combo: "meta+shift+f", description: "Search across sessions" },
  { combo: "meta+shift+v", description: "Toggle Markdown preview" },
  { combo: "meta+,", description: "Open Settings" },
  { combo: "meta+shift+a", description: "Toggle Accounts" },
  { combo: "meta+ctrl+f", description: "Toggle fullscreen (mac)" },
  { combo: "F11", description: "Toggle fullscreen" },
  { combo: "F12", description: "Toggle DevTools (debug builds)" },
];

export interface SelectInput {
  tabs?: { id: string; label: string; kind?: "agent" | "shell" }[];
  activeTabId?: string;
  recentSessions?: {
    id: string;
    label: string;
    lastModified?: string;
    cwd?: string;
  }[];
  sidebar?: {
    projects?: {
      id: string;
      label: string;
      hint?: string;
      tooltip?: string;
      active?: boolean;
      git?: { branch?: string; dirty?: boolean };
    }[];
    themes?: { id: string; label: string; active?: boolean }[];
    layouts?: { id: string; label: string; active?: boolean }[];
    models?: { id: string; label: string; active?: boolean }[];
  };
  slashCommands?: { name: string; description: string; usage?: string }[];
  keybindings?: { combo: string; action: string; description?: string }[];
  layoutCatalogue?: { id: string; label: string; description?: string }[];
  /** Palette state slice. The "files" mode reads the pre-fetched
   *  walk list from `palette.files` — populated by
   *  `openPalette("files")` once `fs_walk_project` returns. */
  palette?: {
    files?: { path: string; rel: string }[];
    projectPath?: string | null;
  };
}

export function selectPaletteItems(
  state: SelectInput,
  mode: PaletteMode,
): PaletteItem[] {
  const items: PaletteItem[] = [];

  const pushTabs = () => {
    for (const t of state.tabs ?? []) {
      // Shell tabs render in the bottom terminal panel as sub-tabs.
      // The palette's "Tabs" section is for top-strip agent tabs only —
      // shell sub-tabs are reachable via the panel's own UI.
      if (t.kind === "shell") continue;
      items.push({
        id: `tab:${t.id}`,
        label: t.label,
        hint: t.id === state.activeTabId ? "active" : "tab",
        section: "tabs",
        payload: { kind: "tab", tabId: t.id },
      });
    }
  };
  const pushSessions = () => {
    for (const s of state.recentSessions ?? []) {
      items.push({
        id: `session:${s.id}`,
        label: s.label,
        hint: s.lastModified,
        section: "sessions",
        payload: {
          kind: "session",
          sessionId: s.id,
          label: s.label,
          ...(s.cwd ? { cwd: s.cwd } : {}),
        },
      });
    }
  };
  const pushProjects = () => {
    items.push({
      id: "project:open",
      label: "Open Project…",
      hint: "Pick a folder",
      section: "projects",
      payload: { kind: "open-project" },
    });
    for (const p of state.sidebar?.projects ?? []) {
      if (p.id === "open-project") continue;
      // Hint priority: tooltip (full path) → git branch → "active".
      // The path is what users actually need to disambiguate; the
      // branch helps when a user has the same dir cloned twice in
      // sibling workspaces.
      const branchTag = p.git?.branch
        ? `${p.git.branch}${p.git.dirty ? "•" : ""}`
        : undefined;
      const hint =
        p.tooltip ?? branchTag ?? p.hint ?? (p.active ? "active" : undefined);
      items.push({
        id: `project:${p.id}`,
        label: p.label,
        hint,
        section: "projects",
        payload: { kind: "project", projectId: p.id },
      });
    }
  };
  const pushCommands = () => {
    for (const c of state.slashCommands ?? []) {
      items.push({
        id: `slash:${c.name}`,
        label: `/${c.name}`,
        hint: c.description,
        section: "commands",
        payload: { kind: "slash", name: c.name },
      });
    }
  };
  const pushKeybindings = () => {
    const overriddenCombos = new Set(
      (state.keybindings ?? []).map((k) => k.combo),
    );
    for (const b of BUILTIN_KEYBINDINGS) {
      if (overriddenCombos.has(b.combo)) continue;
      items.push({
        id: `keybind:builtin:${b.combo}`,
        label: b.description,
        section: "keybindings",
        shortcut: b.combo,
        payload: { kind: "action", action: `builtin:${b.combo}` },
      });
    }
    for (const k of state.keybindings ?? []) {
      items.push({
        id: `keybind:ext:${k.combo}`,
        label: k.description ?? k.action,
        hint: k.action,
        section: "keybindings",
        shortcut: k.combo,
        payload: { kind: "keybinding", combo: k.combo, action: k.action },
      });
    }
  };
  const pushLayouts = () => {
    const cat = state.layoutCatalogue ?? [];
    const active = (state.sidebar?.layouts ?? []).find((l) => l.active)?.id;
    for (const l of cat) {
      items.push({
        id: `layout:${l.id}`,
        label: l.label,
        hint: l.id === active ? "active" : l.description,
        section: "layouts",
        payload: { kind: "layout", layoutId: l.id },
      });
    }
  };
  const pushThemes = () => {
    for (const t of state.sidebar?.themes ?? []) {
      items.push({
        id: `theme:${t.id}`,
        label: t.label,
        hint: t.active ? "active" : undefined,
        section: "themes",
        payload: { kind: "theme", themeId: t.id },
      });
    }
  };
  const pushModels = () => {
    for (const m of state.sidebar?.models ?? []) {
      items.push({
        id: `model:${m.id}`,
        label: m.label,
        hint: m.active ? "active" : m.id,
        section: "models",
        payload: { kind: "model", modelId: m.id },
      });
    }
  };

  const pushFiles = () => {
    for (const f of state.palette?.files ?? []) {
      items.push({
        id: `file:${f.path}`,
        // VSCode-style: leaf in big text, parent dir as hint. The path
        // we display is project-relative so the user can recognise it
        // without needing the absolute prefix.
        label: basenameOf(f.rel),
        hint: dirnameOf(f.rel),
        section: "files",
        payload: { kind: "file", filePath: f.path },
      });
    }
  };

  if (mode === "files") {
    pushFiles();
    // Also include open editor tabs at the top — they're typically what
    // the user is bouncing between. Reuses the "tabs" section so the
    // ranking + section headers stay consistent.
    pushTabs();
    // Load commands + keybindings so the `>` / `?` query prefixes
    // still surface them when the user opens Cmd+P and then changes
    // intent mid-query. rankItems already prioritises whichever
    // section the prefix selects; the items just have to exist for it
    // to filter against.
    pushCommands();
    pushKeybindings();
  } else if (mode === "switcher") {
    pushTabs();
    pushSessions();
    pushProjects();
    pushCommands();
    pushLayouts();
    pushThemes();
    pushModels();
    pushKeybindings();
  } else {
    pushCommands();
    pushKeybindings();
    pushLayouts();
    pushThemes();
    pushModels();
    pushTabs();
    pushSessions();
    pushProjects();
  }
  return items;
}

/** Return the leaf name of a path (last segment after `/` or `\\`). */
function basenameOf(p: string): string {
  if (!p) return "";
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/** Return everything *before* the last segment of a path. Empty for
 *  one-segment paths (so the palette doesn't show a misleading "."). */
function dirnameOf(p: string): string {
  if (!p) return "";
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash > 0 ? p.slice(0, slash) : "";
}

/**
 * Dependency-free scorer. Substring-first so the palette behaves like a
 * filter: typing "theme" finds rows whose label/hint/section actually
 * contains "theme", not every row whose description happens to share
 * the same letters in order.
 *
 * Score tiers (higher = better):
 *   100  exact match
 *   90   exact match ignoring a leading `/` (matches `/theme` on "theme")
 *   80–  prefix match (longer remainder ⇒ slightly lower)
 *   70   word-boundary substring (e.g. "theme" inside "Switch theme by id")
 *   55–  general substring match (drops with offset from start)
 *   1–30 strict fuzzy fallback — char-by-char in order, REQUIRES the
 *        first match to land at a word boundary AND span ≤ 3× query
 *        length. Otherwise 0.
 *   0    no match
 *
 * The "word boundary" rule is what kills the old fuzzy-over-everything
 * bug: the letters t-h-e-m-e occur scattered through "Switch active
 * model by id", but none of them at word-start, so /model now scores 0
 * for "theme".
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!t) return 0;

  if (t === q) return 100;
  // Slash commands render with a leading "/" in their label; users type
  // the bare name, so peel one slash before matching prefixes/exacts.
  const stripped = t.startsWith("/") ? t.slice(1) : t;
  if (stripped === q) return 90;
  if (stripped.startsWith(q)) {
    return 80 - Math.min(20, (stripped.length - q.length) * 0.5);
  }
  if (t.startsWith(q)) {
    return 78 - Math.min(20, (t.length - q.length) * 0.5);
  }
  // Word-boundary substring: query lies at the start of a word inside
  // the haystack. Picks up "theme" inside "Switch theme by id".
  for (let i = 0; i <= t.length - q.length; i++) {
    if (!isWordStart(t, i)) continue;
    if (t.slice(i, i + q.length) === q) {
      return 70 - Math.min(15, i * 0.05);
    }
  }
  const idx = t.indexOf(q);
  if (idx >= 0) return 55 - Math.min(20, idx * 0.4);

  // Last-resort fuzzy. Require the FIRST matched char to be at a word
  // boundary so unrelated rows whose internal letters happen to spell
  // the query (e.g. "theme" inside "Switch active model by id") get
  // rejected. Also bound the span so very loose matches don't outrank
  // genuine hits in another field.
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch < 0) {
        if (!isWordStart(t, ti)) continue;
        firstMatch = ti;
      }
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const span = lastMatch - firstMatch + 1;
  if (span > Math.max(8, q.length * 3)) return 0;
  return Math.max(1, 30 - span * 0.5 - firstMatch * 0.2);
}

const WORD_SEP = /[\s/\-_:,.()]/;

function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  return WORD_SEP.test(s[i - 1] ?? "");
}

/**
 * Score one PaletteItem against the query. Each component (label, hint,
 * section label) is scored independently so we can favor label matches
 * over description matches without conflating their text into one
 * haystack. The section component lets "theme" surface every row in the
 * Themes section, but doesn't bleed into unrelated Slash commands rows.
 */
function scoreItem(item: PaletteItem, q: string): number {
  if (!q) return 1;
  // Strip a leading `/` from the query so typing `theme` or `/theme`
  // both match `/theme` cleanly.
  const queryNoSlash = q.startsWith("/") ? q.slice(1) : q;
  const labelScore = fuzzyScore(queryNoSlash, item.label);
  const hintScore = item.hint ? fuzzyScore(queryNoSlash, item.hint) * 0.6 : 0;
  const sectionScore =
    fuzzyScore(queryNoSlash, SECTION_LABEL[item.section]) * 0.5;
  const shortcutScore = item.shortcut
    ? fuzzyScore(queryNoSlash, item.shortcut) * 0.4
    : 0;
  return Math.max(labelScore, hintScore, sectionScore, shortcutScore);
}

export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  let q = query.trim();
  let preferred: PaletteSection | null = null;
  if (q.startsWith(">")) {
    preferred = "commands";
    q = q.slice(1).trim();
  } else if (q.startsWith("@")) {
    preferred = "tabs";
    q = q.slice(1).trim();
  } else if (q.startsWith("?")) {
    preferred = "keybindings";
    q = q.slice(1).trim();
  }
  if (!q) return items;
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    let score = scoreItem(item, q);
    if (score <= 0) continue;
    if (preferred && item.section === preferred) score += 20;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
