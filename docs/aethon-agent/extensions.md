# Aethon Extensions

Aethon supports three distribution channels for user-shipped UI code:

1. **Loose files** in `~/.aethon/extensions/*.{ts,js,mjs}` — fast, single-
   file extensions. Bun executes `.ts` directly so no build step.
2. **Project-local loose files** in
   `<project>/.aethon/extensions/*.{ts,js,mjs}` — repository-scoped UI
   extensions discovered from the selected cwd up to the nearest git root.
3. **npm-distributed skill packages** in
   `~/.aethon/skills/node_modules/<pkg>/` — for extensions with
   dependencies, multi-file source, or for sharing via npm.

Both channels call the same `register(api)` entry point with the same
API surface. Extension code runs in the **bridge process** (Bun), not
the webview, so it has Node.js / Bun APIs but not DOM APIs.

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
export function register(api: AethonApi) { /* … */ }
```

Drop the file in `~/.aethon/extensions/` and reload (`/reset` in chat,
or just send a new message — the bridge picks up changes via the
filesystem watcher).

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

## npm-Distributed Skill

```
~/.aethon/skills/node_modules/@vendor/aethon-pretty-themes/
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
/skills install @vendor/aethon-pretty-themes
# or, from a shell:
npm install --prefix ~/.aethon/skills @vendor/aethon-pretty-themes
```

The in-app installer also accepts GitHub shorthands and git URLs, for
example `/skills install github:vendor/aethon-pretty-themes`. After install,
the current agent sidecar is restarted so the next request loads the new
package. The bridge walks `~/.aethon/skills/node_modules/`
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
  // Introspection
  listExtensions(): { name, source }[];
  listComponents(): Record<string, unknown>;
  listThemes(): { id, label, vars }[];
  getLayout(): unknown;
  getRuntimeSnapshot(): { release, cwd, docsDir, ..., extensions, components, themes };
}
```

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
    await ctx.pi.prompt("Run `git log --oneline -20` and group commits by intent.");
  },
);
```

### 3. Live-updating chip in the header

```ts
api.registerComponent("model-chip", {
  components: [{
    id: "chip",
    type: "container",
    props: { direction: "row", gap: 6, padding: 6, className: "chip" },
    children: [
      { id: "chip-label", type: "text",
        props: { content: "model:", variant: "small", color: "var(--text-dim)" } },
      { id: "chip-value", type: "text",
        props: { content: { "$ref": "/model" }, variant: "small" } },
    ],
  }],
});

// Insert it into the header row
api.patchLayout("/components/0/children/0/children/2", {
  id: "header-chip", type: "model-chip",
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
  components: [{
    id: "card", type: "card", props: { title: "Weather" },
    children: [
      { id: "temp", type: "text",
        props: { content: { "$ref": "/weather/temp" }, variant: "large" } },
      { id: "summary", type: "text",
        props: { content: { "$ref": "/weather/summary" } } },
    ],
  }],
});
```

### 5. Replace the layout (advanced)

```ts
import defaultLayout from "./fallback-layout.json"; // ship a copy

api.setLayout({
  components: [
    { id: "root", type: "layout",
      props: { columns: "1fr", rows: "1fr", areas: ["main"] },
      children: [
        { id: "main", type: "main-canvas", props: { area: "main" } },
      ],
    },
  ],
});
```

You probably don't want this unless you're building a focused-mode
extension — `setLayout` replaces sidebar, header, status bar, the lot.
Prefer `patchLayout` for incremental tweaks.

### 6. Drive a user shell tab via `ctx.shells`

Event handlers can reach the same shell sharing API as the model:

```ts
api.onEvent(
  { componentType: "sidebar-item", descendantId: "diagnose-shell" },
  async (event, ctx) => {
    const shells = await ctx.shells.list();
    if (!shells.ok || !shells.data?.length) {
      ctx.pi.notify("No shareable shells. Click the badge to flip one to 'read'.");
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

### 7. Custom A2UI component reused as a card type

```ts
api.registerComponent("info-card", {
  components: [{
    id: "ic", type: "card",
    props: {
      title: { "$ref": "/cards/0/title" },
      description: { "$ref": "/cards/0/body" },
    },
  }],
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

## Debugging

- Stderr from extensions shows in the dev console via `agent-stderr`
  events (and in the status bar when the dev build is running).
- The aethon-debug skill (`.claude/skills/aethon-debug/`) drives the
  webview from outside — useful when iterating on UI changes:
  `${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.aethon.listExtensions()'`.
- The state file at `$AETHON_STATE_FILE` (default `~/.aethon/state.json`)
  is the easiest way to verify what's loaded — it's regenerated whenever
  any registration fires.
