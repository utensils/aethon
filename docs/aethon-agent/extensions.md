# Aethon Extensions

Aethon supports three distribution channels for user-shipped UI code:

1. **Loose files** in `~/.aethon/extensions/*.{ts,js,mjs}` — fast, single-
   file extensions. Bun executes `.ts` directly so no build step.
2. **Project-local loose files** in
   `<project>/.aethon/extensions/*.{ts,js,mjs}` — repository-scoped UI
   extensions discovered from the selected cwd up to the nearest git root.
3. **npm-distributed extension packages** in
   `~/.aethon/extensions/node_modules/<pkg>/` — for extensions with dependencies, multi-file
   source, or for sharing via npm.

All bridge-side channels call the same `register(api)` entry point with
the same API surface. Extension code runs in the **bridge process** (Bun),
not the webview, so it has Node.js / Bun APIs but not DOM APIs.

## Loose Extension

```ts
// ~/.aethon/extensions/hello.ts
import type { AethonApi } from "./aethon-types";

export default {
  register(api: AethonApi) {
    api.registerSidebarSection({
      id: "hello",
      title: "Greetings",
      items: [{ id: "say-hi", label: "Say hi" }],
    });

    api.onEvent(
      { componentType: "sidebar-item", descendantId: "say-hi" },
      (_event, ctx) => {
        ctx.pi.notify("Hello from the hello extension!");
      },
    );
  },
};
```

You can also export `register` directly:

```ts
export function register(api: AethonApi) {
  /* … */
}
```

Drop the file in `~/.aethon/extensions/` and reload (`/reload` in chat,
or just send a new message — the bridge picks up changes via the
filesystem watcher after active prompts drain).

## Project-Local Extension

Use project-local extensions when the UI belongs to a repository:

```ts
// <repo>/.aethon/extensions/repo-tools.ts
export function register(api) {
  api.registerSidebarSection({
    id: "repo-tools",
    title: "Repo tools",
    items: [{ id: "explain-architecture", label: "Explain architecture" }],
  });
}
```

When a tab opens with a project cwd, Aethon walks from that cwd up to the
nearest git root and loads each existing `.aethon/extensions` directory,
root-first. Nested directories can intentionally override parent-level
components, themes, layouts, or handlers. Project extensions are loaded once
per bridge process and appear in `listExtensions()` with source
`"project-directory"`.

## npm-Distributed Extension Package

```
~/.aethon/extensions/node_modules/@vendor/aethon-pretty-themes/
├── package.json
├── dist/
│   └── index.js
```

`package.json`:

```json
{
  "name": "@vendor/aethon-pretty-themes",
  "version": "1.0.0",
  "aethon": { "entry": "./dist/index.js" }
}
```

Install with:

```bash
/extensions install @vendor/aethon-pretty-themes
# or, from a shell:
npm install --prefix ~/.aethon/extensions @vendor/aethon-pretty-themes
```

The in-app installer also accepts GitHub shorthands and git URLs, for
example `/extensions install github:vendor/aethon-pretty-themes`. After
install, the current agent sidecar is restarted so the next request
loads the new package. The bridge walks `~/.aethon/extensions/node_modules/`
(including `@scope` namespaces), finds packages with an `aethon` field,
imports `aethon.entry`, and calls `register(api)`.

## API Surface

The `api` object passed to `register` is the same surface as
`globalThis.aethon`. See `api.md` for the full reference.

```ts
interface AethonApi {
  registerComponent(type: string, template: unknown): void;
  setState(path: string, value: unknown): void;
  onEvent(match: A2UIEventMatch, handler: A2UIEventHandler): void;
  setLayout(payload: unknown): void;
  patchLayout(pointer: string, value: unknown): void;
  registerSidebarSection(section: { id, title, items? }): void;
  registerTheme(theme: { id, label?, vars }): void;
  windows: {
    openCanvas(input: {
      id?: string;
      title?: string;
      components?: unknown;
      state?: unknown;
      width?: number;
      height?: number;
      x?: number;
      y?: number;
      focus?: boolean;
      restoreOnLaunch?: boolean;
    }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
    emitCanvas(id: string, components: unknown): Promise<{ ok: boolean }>;
    appendCanvas(id: string, components: unknown): Promise<{ ok: boolean }>;
    patchCanvas(id: string, path: string, value: unknown): Promise<{ ok: boolean }>;
    clearCanvas(id: string): Promise<{ ok: boolean }>;
    setState(id: string, path: string, value: unknown): Promise<{ ok: boolean }>;
    list(): Promise<{ ok: boolean; data?: unknown[] }>;
    focus(id: string): Promise<{ ok: boolean }>;
    close(id: string): Promise<{ ok: boolean }>;
    setTitle(id: string, title: string): Promise<{ ok: boolean }>;
  };
  // Introspection
  listExtensions(): { name, source }[];
  listComponents(): Record<string, unknown>;
  listThemes(): { id, label, vars }[];
  getLayout(): unknown;
  getRuntimeSnapshot(): { release, cwd, docsDir, ..., extensions, components, themes };
}
```

`onEvent` matches can include `surfaceId` and `windowId`. When the event
comes from a native canvas window, the handler context also includes
`ctx.window` with `setState`, `emit`, `append`, `patch`, `clear`,
`setTitle`, `focus`, and `close` helpers scoped to that window.

## Recipes

### 1. Register a theme

```ts
api.registerTheme({
  id: "ocean",
  label: "Ocean",
  vars: {
    "--bg": "#0b1f33",
    "--bg-elev": "#11324f",
    "--text": "#e6f0fa",
    "--text-dim": "#7ea7c2",
    "--accent": "#4fc3f7",
    "--border": "#1d4a73",
  },
});
```

#### Design token surface

The four legacy tokens above are the bare minimum; the built-in
palettes in `src/styles/themes.css` set roughly 90 tokens each so the
chrome reads as a coordinated design system. The extra categories are
**opt-in** — leave them unset and the browser falls back to its
defaults (or `unset` where the chrome rule doesn't carry a fallback),
which is rarely what a polished theme wants. The recommended baseline:

| Category                     | Tokens                                                                                                                                                | Why                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surface tiers                | `--surface-0` … `--surface-4`                                                                                                                         | Graduated planes for sidebars, cards, modals. Without them, every elevated panel collapses onto `--bg-elev`.                                                                                                         |
| Secondary + tertiary accents | `--accent-2`, `--accent-2-soft`, `--accent-2-hover-tint`, `--accent-2-active-tint`, `--text-on-accent-2`, `--accent-3`, `--accent-3-soft`             | Hierarchical CTAs and informational chips so the UI doesn't read monochromatic.                                                                                                                                      |
| Semantic state quads         | `--state-{success,warning,error,info}-{bg,fg,border,strong}`                                                                                          | Banners, toasts, status chips. `--success/--warn/--error` are kept as legacy single colours.                                                                                                                         |
| Elevation tints              | `--elev-1-color` … `--elev-5-color`                                                                                                                   | Paired with `--elev-N-shape` from `tokens.css` to compose `--shadow-1..5` and `--shadow-overlay`. Tune alpha per palette mood (dark themes carry deeper alphas; light themes stay subtle).                           |
| Inner highlight              | `--inner-highlight`                                                                                                                                   | A 1px top-edge sheen on elevated panels. Light themes get a stronger white (≈0.6); dark themes a faint one (≈0.04–0.06).                                                                                             |
| Gradient stops               | `--gradient-surface`, `--gradient-accent`, `--gradient-app-backdrop`                                                                                  | Sidebar/header wash, primary CTA gradient, and the subtle radial behind the canvas.                                                                                                                                  |
| Chrome composites            | `--card-{bg,border,shadow}`, `--pill-{bg,border,text}`, `--composer-{bg,border,shadow}`, `--popover-{bg,border,shadow}`, `--modal-{bg,border,shadow}` | Semantic aliases that chrome.css reads directly. Override one to re-skin every card / pill / popover in the app. `--composer-shadow` must be an **upward** (negative-Y) shadow — the composer sits above the canvas. |
| Typography roles             | `--type-{display,title,body,caption,code}-{size,line,weight,tracking}`                                                                                | Composed in `tokens.css` from the `--text-*` scale; rarely needs per-theme override unless the palette wants a different running-text rhythm.                                                                        |

A minimal "polished" theme overrides at least: every surface tier, both
accents, the four state quads, all five elevation tints, the inner
highlight, and the gradient stops. That's ~40 declarations, but each
makes a visible difference in cards/pills/popovers/composer.

Reserved ids (cannot be reused): `ember`, `paper`, `aether`,
`signature`, `brink`, `daylight`, `mist`, `nocturne`.

### 2. Register a sidebar section that runs a prompt

```ts
api.registerSidebarSection({
  id: "git",
  title: "Git",
  items: [
    { id: "git-status", label: "Status" },
    { id: "git-summary", label: "Summarize log" },
  ],
});

api.onEvent(
  { componentType: "sidebar-item", descendantId: "git-status" },
  async (_e, ctx) => {
    await ctx.pi.prompt("Run `git status` and summarize the result.");
  },
);

api.onEvent(
  { componentType: "sidebar-item", descendantId: "git-summary" },
  async (_e, ctx) => {
    await ctx.pi.prompt(
      "Run `git log --oneline -20` and group commits by intent.",
    );
  },
);
```

### 3. Live-updating chip in the header

```ts
api.registerComponent("model-chip", {
  components: [
    {
      id: "chip",
      type: "container",
      props: { direction: "row", gap: 6, padding: 6, className: "chip" },
      children: [
        {
          id: "chip-label",
          type: "text",
          props: {
            content: "model:",
            variant: "small",
            color: "var(--text-dim)",
          },
        },
        {
          id: "chip-value",
          type: "text",
          props: { content: { $ref: "/model" }, variant: "small" },
        },
      ],
    },
  ],
});

// Insert it into the header row
api.patchLayout("/components/0/children/0/children/2", {
  id: "header-chip",
  type: "model-chip",
});
```

### 4. Background poller pushing into a bound state path

```ts
async function pollWeather() {
  while (true) {
    const r = await fetch("https://api.example.com/weather/sf");
    const j = await r.json();
    api.setState("/weather", { temp: j.temperature, summary: j.summary });
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
pollWeather().catch((e) => console.error("[weather] poller stopped:", e));

api.registerComponent("weather-card", {
  components: [
    {
      id: "card",
      type: "card",
      props: { title: "Weather" },
      children: [
        {
          id: "temp",
          type: "text",
          props: { content: { $ref: "/weather/temp" }, variant: "large" },
        },
        {
          id: "summary",
          type: "text",
          props: { content: { $ref: "/weather/summary" } },
        },
      ],
    },
  ],
});
```

### 5. Replace the layout (advanced)

```ts
import defaultLayout from "./fallback-layout.json"; // ship a copy

api.setLayout({
  components: [
    {
      id: "root",
      type: "layout",
      props: { columns: "1fr", rows: "1fr", areas: ["main"] },
      children: [{ id: "main", type: "main-canvas", props: { area: "main" } }],
    },
  ],
});
```

You probably don't want this unless you're building a focused-mode
extension — `setLayout` replaces sidebar, header, status bar, the lot.
Prefer `patchLayout` for incremental tweaks.

### 6. Open a native canvas window

Native canvas windows are the preferred home for exploratory/custom UI that
should not replace the main Aethon workspace. They render the same A2UI
templates, `aethon.frontendEntry` React components, themes, and highlight
grammars as the main window.

```ts
await api.windows.openCanvas({
  id: "repo-health",
  title: "Repo Health",
  components: [
    {
      id: "refresh",
      type: "button",
      props: { label: "Refresh" },
    },
    {
      id: "status",
      type: "card",
      props: { title: "Status" },
      children: [
        {
          id: "summary",
          type: "paragraph",
          props: { content: { $ref: "/summary" } },
        },
      ],
    },
  ],
  state: { summary: "Ready" },
});

api.onEvent(
  { windowId: "repo-health", componentType: "button", eventType: "click" },
  async (_event, ctx) => {
    await ctx.window?.setState("/summary", "Refreshing...");
    await ctx.pi.prompt("Refresh the repository health summary.");
  },
);
```

Windows restore on app relaunch by default. Pass `restoreOnLaunch: false`
for one-off scratch surfaces.

### 7. Drive a user shell tab via `ctx.shells`

Event handlers can reach the same shell sharing API as the model:

```ts
api.onEvent(
  { componentType: "sidebar-item", descendantId: "diagnose-shell" },
  async (event, ctx) => {
    const shells = await ctx.shells.list();
    if (!shells.ok || !shells.data?.length) {
      ctx.pi.notify(
        "No shareable shells. Click the badge to flip one to 'read'.",
      );
      return;
    }
    const tab = shells.data[0];
    const last = await ctx.shells.read({ tabId: tab.tabId, maxBytes: 4096 });
    if (last.ok && last.data?.content) {
      await ctx.pi.prompt(
        `Diagnose the recent output from "${tab.command}":\n\n${last.data.content}`,
      );
    }
  },
);
```

`ctx.shells.write` pops the same Allow / Deny prompt the model writes
hit when the tab is in `read-write` — the security boundary lives in
Rust regardless of how the API is reached. Calls during register-time
return `frontend_not_ready`; defer them into a handler or a sidebar
click to give the bridge handshake time to settle.

### 8. Custom A2UI component reused as a card type

```ts
api.registerComponent("info-card", {
  components: [
    {
      id: "ic",
      type: "card",
      props: {
        title: { $ref: "/cards/0/title" },
        description: { $ref: "/cards/0/body" },
      },
    },
  ],
});

api.setState("/cards", [{ title: "Hello", body: "World" }]);
```

You can then return `{components: [{type: "info-card"}]}` from a tool
result and the renderer expands the template.

## Lifecycle

- Extensions run **once** at bridge startup (or when the bridge
  respawns due to filesystem changes in dev).
- `register` may be `async` — the bridge awaits it before announcing
  `ready`. Use this for one-time fetches or dynamic provider discovery.
- Failures in one extension don't block others. Errors are logged to
  stderr and surface as `agent-stderr` events to the frontend.
- The bridge dedupes event handlers by `(match, handler.toString())` so
  re-registering the same handler across reloads doesn't multiply side
  effects.
- Project extensions can register a teardown callback via
  `api.onUnload(fn)`. When the user switches projects, the bridge
  calls each registered `onUnload` before loading the new project's
  extensions. Use this to clear intervals, close connections, or
  remove state paths that belong to the outgoing project.

## Debugging

- Stderr from extensions shows in the dev console via `agent-stderr`
  events (and in the status bar when the dev build is running).
- The aethon-debug skill (`.claude/skills/aethon-debug/`) drives the
  webview from outside — useful when iterating on UI changes:
  `${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.aethon.listExtensions()'`.
- The state file at `$AETHON_STATE_FILE` (default `~/.aethon/state.json`)
  is the easiest way to verify what's loaded — it's regenerated whenever
  any registration fires.
