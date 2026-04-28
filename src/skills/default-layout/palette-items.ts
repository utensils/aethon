// Pure helpers for the command palette — split out from
// command-palette.tsx so vitest tests can import them without a React
// runtime, and so react-refresh doesn't trip over a non-component
// export sharing the file with components.

export type PaletteMode = "switcher" | "commands";

export type PaletteSection =
  | "tabs"
  | "sessions"
  | "projects"
  | "commands"
  | "keybindings"
  | "layouts"
  | "themes"
  | "models"
  | "actions";

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
};

export type PalettePayload =
  | { kind: "tab"; tabId: string }
  | { kind: "session"; sessionId: string; label: string }
  | { kind: "project"; projectId: string }
  | { kind: "open-project"; }
  | { kind: "slash"; name: string; args?: string }
  | { kind: "keybinding"; combo: string; action: string }
  | { kind: "layout"; layoutId: string }
  | { kind: "theme"; themeId: string }
  | { kind: "model"; modelId: string }
  | { kind: "action"; action: string };

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
  { combo: "meta+p", description: "Open command palette (switcher)" },
  { combo: "meta+shift+p", description: "Open command palette (commands)" },
  { combo: "meta+t", description: "New tab" },
  { combo: "meta+w", description: "Close active tab" },
  { combo: "meta+]", description: "Next tab" },
  { combo: "meta+[", description: "Previous tab" },
  { combo: "meta+`", description: "Toggle terminal" },
];

export interface SelectInput {
  tabs?: { id: string; label: string }[];
  activeTabId?: string;
  recentSessions?: { id: string; label: string; lastModified?: string }[];
  sidebar?: {
    projects?: { id: string; label: string; hint?: string; active?: boolean }[];
    themes?: { id: string; label: string; active?: boolean }[];
    layouts?: { id: string; label: string; active?: boolean }[];
    models?: { id: string; label: string; active?: boolean }[];
  };
  slashCommands?: { name: string; description: string; usage?: string }[];
  keybindings?: { combo: string; action: string; description?: string }[];
  layoutCatalogue?: { id: string; label: string; description?: string }[];
}

export function selectPaletteItems(
  state: SelectInput,
  mode: PaletteMode,
): PaletteItem[] {
  const items: PaletteItem[] = [];

  const pushTabs = () => {
    for (const t of state.tabs ?? []) {
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
        payload: { kind: "session", sessionId: s.id, label: s.label },
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
      items.push({
        id: `project:${p.id}`,
        label: p.label,
        hint: p.hint ?? (p.active ? "active" : undefined),
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
    for (const b of BUILTIN_KEYBINDINGS) {
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

  if (mode === "switcher") {
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

// Cheap, dependency-free fuzzy scorer. Returns >0 if the query matches
// in order; higher = better. Two heuristics:
//   - prefix / contiguous-substring matches score highest
//   - in-order char run with small gaps still matches but ranks lower
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - (t.length - q.length) * 0.1;
  const idx = t.indexOf(q);
  if (idx >= 0) return 60 - idx * 0.5;
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch < 0) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const span = lastMatch - firstMatch + 1;
  return Math.max(1, 30 - span * 0.5 - firstMatch * 0.2);
}

export function rankItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
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
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const haystack = `${item.label} ${item.hint ?? ""} ${item.id}`;
    let score = fuzzyScore(q, haystack);
    if (score <= 0) continue;
    if (preferred && item.section === preferred) score += 20;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
