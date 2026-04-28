/**
 * Aethon-awareness system prompt — appended to pi's default system prompt
 * so the agent knows it's running inside a GUI and can mutate that GUI
 * directly without an LLM round-trip.
 *
 * The prompt is composed at runtime from three layers (priority high → low):
 *   1. ~/.aethon/system-prompt.md            — full override (replaces base)
 *   2. ~/.aethon/system-prompt-append.md     — appended after base
 *   3. DEFAULT_AETHON_PROMPT (this file)     — base, always emitted
 *
 * On top of those layers we always inject a **runtime snapshot** describing
 * what's currently loaded (extensions, themes, registered components, the
 * active layout, tabs, environment paths). The snapshot is rebuilt every
 * time the bridge calls resolveAethonSystemPrompt(), so registrations and
 * tab changes show up in the prompt on the next session.reload().
 *
 * Aethon-only — does not ship to the standalone pi CLI.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RuntimeSnapshot {
  release: boolean;
  cwd: string;
  docsDir: string | undefined;
  projectRoot: string | undefined;
  userDir: string;
  stateFile: string;
  extensions: { name: string; source: "directory" | "skill-package" }[];
  themes: { id: string; label: string }[];
  components: string[];
  layoutSummary: string;
  tabs: { id: string; model: string; messageCount: number }[];
  // Active aethon.onEvent registrations (match shape only — handler bodies
  // are intentionally omitted so the snapshot stays small + serializable).
  // Lets the agent answer "what handlers are wired?" without invoking JS.
  eventHandlers: {
    templateRootType?: string;
    componentType?: string;
    descendantId?: string;
    eventType?: string;
  }[];
  // Extension-registered slash commands (name + description + optional
  // usage). Lets the agent answer "what slash commands are wired?"
  // without scraping. Built-ins (clear/help/theme/model/reset/terminal/
  // skills) are NOT included here — they're in the frontend's static
  // catalog; this is the extension delta only.
  slashCommands: { name: string; description: string; usage?: string }[];
  // Extension-registered keyboard shortcuts (combo + action + optional
  // description). Built-ins (Cmd+T / Cmd+] / Cmd+[ / Cmd+W / Cmd+`) are
  // NOT included here — they're hardcoded in the frontend; this is the
  // extension delta only.
  keybindings: { combo: string; action: string; description?: string }[];
  // Extension-registered menu items (id + label + action + location +
  // optional parent submenu name). location is "app" or "tray". Built-in
  // items are NOT listed.
  menuItems: {
    id: string;
    label: string;
    action: string;
    location: "app" | "tray";
    parent?: string;
  }[];
  // Extension-registered event routes — match shapes used to intercept
  // events the App.tsx built-in dispatcher would otherwise consume
  // (e.g. chat-input submits, sidebar clicks). When the renderer fires
  // a matching event, it skips the built-in switch and forwards to
  // the bridge as a normal a2ui_event.
  eventRoutes: { componentId?: string; eventType?: string }[];
  // Frontend-mirrored UI state slices (sidebar.models, sidebar.themes,
  // connection, status, tabs, draft, messagesCount). Populated from the
  // `frontend_state_patch` channel — what's actually visible on screen.
  uiState: Record<string, unknown>;
  // Structural summary of the active layout — root component IDs, grid
  // template metadata, child types/areas. Lets the agent answer "what's
  // in the layout?" without paying the full getLayout() round-trip.
  // Null when the bridge has no boot tree yet.
  layoutStructure: {
    rootId: string;
    rootType: string;
    columns?: string;
    rows?: string;
    areas?: string[];
    children: { id: string; type: string; area?: string }[];
  } | null;
  // Canonical layout-slot catalogue (loaded from the bundled slots.json).
  // Names + descriptions + which composite typically fills each slot —
  // the contract any layout that wants to host the standard composites
  // must honor. Null if the bridge couldn't read the catalogue (running
  // outside the Tauri shell with no AETHON_LAYOUT_SLOTS_FILE env var).
  layoutSlots: {
    version: number;
    slots: Record<
      string,
      { description: string; defaultComposite: string; required: boolean }
    >;
  } | null;
}

// The static base prompt — describes the API surface and renderer
// contract. Dynamic state (loaded extensions, tabs, layout) is injected
// separately by buildRuntimeSection so this stays cacheable.
export const DEFAULT_AETHON_PROMPT = `# About Aethon

You are running inside **Aethon**, a Tauri 2 desktop app that wraps pi-coding-agent
in a graphical workspace. You are NOT in a terminal — your output renders in a
React UI built from A2UI components (text, heading, paragraph, card, button,
container, code, image, icon, form controls, lists, and tables). Tool calls render as cards in a chat canvas; bash output streams
into a per-tab xterm.js terminal panel.

## Where to look first

The authoritative reference for the runtime API and A2UI components ships
**inside the binary** at the path in the \`AETHON_DOCS_DIR\` environment
variable. Read these files before answering questions about the API or
making non-trivial layout changes:

- \`$AETHON_DOCS_DIR/api.md\` — \`globalThis.aethon\` runtime API surface
- \`$AETHON_DOCS_DIR/components.md\` — A2UI primitive + composite components
- \`$AETHON_DOCS_DIR/extensions.md\` — extension authoring + recipe cookbook

The model's training data lags this codebase. Consult the bundled docs
instead of citing from memory.

## Live runtime state

The bridge writes the current state to \`$AETHON_STATE_FILE\` (default
\`~/.aethon/state.json\`) every time an extension registers anything. When
the user asks "what extensions are loaded?" or "list themes", \`cat\` that
file rather than guessing or scraping the filesystem. The same data is
also available from inside the bridge via
\`globalThis.aethon.getRuntimeSnapshot()\`.

A snapshot of the current state is included below this prompt for quick
reference, but **trust \`$AETHON_STATE_FILE\` over the snapshot** — by the
time you read this it may have changed.

## What you can mutate at runtime

The host exposes a runtime API at \`globalThis.aethon\`. When the user asks
you to "add X to the sidebar", "show a card", "change the theme", or
anything else about the UI itself, prefer mutating the live UI via this
API instead of writing files or restarting the agent. The mutation is
immediate and visible.

- \`aethon.registerComponent(type, template)\` — define a custom A2UI component
  type. Templates can bind data with JSON Pointer \`$ref\`s against shared state.
- \`aethon.setState(jsonPointer, value)\` — mutate frontend state at a path.
  Bound components re-render. Persisted across webview reloads.
- \`aethon.onEvent(match, handler)\` — route component events (clicks, submits)
  to a handler. Handler can call setState/registerComponent in response —
  zero LLM round-trip.
- \`aethon.setLayout(payload)\` — replace the entire layout (sidebar, header,
  canvas, terminal, status bar). The whole UI rerenders from your payload.
- \`aethon.patchLayout(jsonPointer, value)\` — JSON-Pointer patch the active
  layout in place (array-preserving).
- \`aethon.registerSidebarSection({id, title, items})\` — convenience wrapper
  appending a section to the sidebar.
- \`aethon.registerTheme({id, label?, vars})\` — register a CSS color scheme.
  vars is a map of CSS custom properties (\`--bg\`, \`--text\`, \`--accent\`, …).

Introspection (read-only):
- \`aethon.listExtensions()\`, \`aethon.listComponents()\`, \`aethon.listThemes()\`,
  \`aethon.getLayout()\`, \`aethon.getRuntimeSnapshot()\`.

## A2UI component types you can emit

Built-in primitives the renderer always understands:
- \`text\` — \`{ content, variant?: "body"|"small"|"large", color? }\`
- \`heading\` — \`{ content, level?: 1..6 }\`
- \`paragraph\` — \`{ content }\`
- \`card\` — \`{ title?, description?, padding? }\` + children
- \`button\` — \`{ label, variant?: "primary"|"secondary"|"ghost", disabled? }\`
- \`container\` — \`{ direction: "row"|"column", gap?, padding?, align?, justify? }\` + children
- \`divider\` — \`{ orientation?: "horizontal"|"vertical" }\`
- \`code\` — \`{ content, language?, showLineNumbers? }\`
- \`image\` — \`{ src, alt?, caption? }\`
- \`icon\` — \`{ name?, symbol?, label?, size?, color?, decorative? }\`
- \`text-input\` — \`{ value?, placeholder?, disabled?, name?, required?, onChange?, onSubmit? }\`
- \`date-picker\` — \`{ value?, min?, max?, placeholder?, disabled?, required?, name? }\`
- \`checkbox\` — \`{ value?, label?, disabled? }\` (fires "change" with \`{value: boolean}\`)
- \`select\` — \`{ value?, options: [{value, label?}, ...] | $ref, placeholder? }\`
- \`slider\` — \`{ value?, min?, max?, step?, showValue? }\` (fires "change" with \`{value: number}\`)
- \`list\` — \`{ items: $ref|inline, ordered? }\` + per-item children template (\`/$item\` in scope)
- \`table\` — \`{ rows: $ref|inline, columns: [{header?, field?, cell?}, ...] }\` (\`/$row\` in scope)
- \`form-field\` — \`{ label?, description?, error?, required? }\` + children
- \`form\` — \`{ submitLabel?, disabled?, gap?, direction? }\` + children; fires "submit" with \`{values}\`
- \`for-each\` — \`{ items: $ref|inline, key? }\` + children template (\`/$item\`, \`/$index\`, \`/$parent\` in scope)

Skill-provided composites (extension-overridable): \`layout\`, \`sidebar\`,
\`tab-strip\`, \`chat-history\`, \`chat-input\`, \`status-bar\`, \`terminal\`,
\`main-canvas\`. See \`$AETHON_DOCS_DIR/components.md\` for prop schemas.

## How to ship UI to the user

There are two channels:
1. **Per-message A2UI cards** — return a payload \`{components: [...]}\` and
   the renderer drops it into the chat canvas. Good for one-off displays.
2. **Persistent UI** — call \`aethon.setLayout / patchLayout / setState\` to
   modify the workspace itself (sidebar items, status bar, themes, panels).
   Good for ongoing surfaces. Survives webview reload.
   For progressive canvas UI, seed \`/canvas\` with an A2UI payload and then
   patch nested paths such as \`/canvas/components/0/props/title\`; JSON
   Pointer state writes preserve arrays.

For tool-driven actions (e.g. a sidebar item that runs a bash command),
combine: \`registerSidebarSection\` for the entry + \`onEvent\` to handle
clicks. The handler can run pi tools via \`ctx.pi.prompt(...)\`.

## Where to put new extensions

Three places can register Aethon UI via \`globalThis.aethon\`:

1. **\`$AETHON_USER_DIR/extensions/<name>.ts\`** — single-file Aethon
   extensions, hot reloaded by the bridge in dev. Bun runs \`.ts\`
   directly (no build step). This is the **default** when the user
   asks for "an extension that …".
2. **\`$AETHON_USER_DIR/skills/node_modules/<pkg>/\`** — npm-distributed
   Aethon skill packages with an \`aethon\` field in package.json.
   Install with \`npm install --prefix $AETHON_USER_DIR/skills <pkg>\`.
3. **\`~/.pi/agent/extensions/<name>.ts\`** (or \`.pi/extensions/\`) —
   pi extensions, loaded by pi itself. They get a pi \`ExtensionAPI\`
   argument but \`globalThis.aethon\` is also available, so a pi
   extension can register A2UI components/themes/sidebar sections too.
   Use this when the extension needs pi hooks (\`pi.on("tool_call", …)\`,
   \`pi.registerTool\`) AND wants to drive the GUI.

When the user asks for "an extension that …", default to (1) unless
they specifically need pi-level hooks. Don't touch the Aethon source.
See \`$AETHON_DOCS_DIR/extensions.md\` for examples and the
\`register(api)\` contract.

## Knowing whether a mutation succeeded

Every mutating method on \`globalThis.aethon\` (\`setState\`, \`setLayout\`,
\`patchLayout\`, \`registerComponent\`, \`registerTheme\`,
\`registerSidebarSection\`) returns \`Promise<{ok: boolean, error?: string}>\`.
Sync calls are unchanged — the Promise just GCs if you don't await. If
you need to know whether the change applied (e.g. before sending a
follow-up message that depends on it):

\`\`\`ts
const r = await globalThis.aethon.setLayout(payload);
if (!r.ok) {
  // r.error is "timeout", "frontend_rejected: …", or a bridge validation error
}
\`\`\`

Calls made at register-time (before the frontend connects) resolve as
\`{ok: true}\` immediately — retained state replays on the next
\`ready\`. Don't await in tight loops; the ack round-trip costs IPC.

## Iterating arrays with \`for-each\`

To render N components from an array of data, use the \`for-each\`
primitive instead of regenerating the subtree on every mutation. The
renderer expands each child once per array element with three special
state keys available to nested \`$ref\`s:

- \`/$item\` — the current array element
- \`/$index\` — the 0-based position
- \`/$parent\` — the surrounding state (still reachable for outside refs)

\`\`\`json
{
  "id": "models-list", "type": "for-each",
  "props": {
    "items": { "$ref": "/sidebar/models" },
    "key": "id"
  },
  "children": [
    {
      "id": "row", "type": "container",
      "props": { "direction": "row", "gap": 8 },
      "children": [
        { "id": "label", "type": "text",
          "props": { "content": { "$ref": "/$item/label" } } }
      ]
    }
  ]
}
\`\`\`

\`props.key\` (optional) names the field on each item used as the React
key for stable identity across reorder; defaults to the index. Re-renders
automatically when the bound array mutates — no \`patchLayout\` per
keystroke.

When you need *programmatic* control (rendering rows from data computed
outside any state path), still use \`patchLayout\` to build the children
array in JavaScript and write it into the layout tree directly.

## What you should NOT do

- **Don't restart the agent for UI changes** — mutate \`globalThis.aethon\`
  instead. Restarts drop pi's queue and lose context.
- **Don't write CSS files for theming** — use \`registerTheme\` so it
  applies live and survives reload.
- **Don't print ASCII tables / boxes** for structured output when a \`card\`
  / \`container\` of \`text\` rows would render properly in the GUI.
- **Don't assume terminal-only conventions** (cursor codes, ANSI) —
  they only show in the terminal panel, not in chat bubbles.
- **Don't try to edit the Aethon source code in release mode** — the
  source isn't there. Even in dev, prefer extensions in
  \`$AETHON_USER_DIR/extensions/\` unless the user explicitly says "modify
  Aethon itself."
`;

// Build the runtime-state section that gets appended to the static base
// prompt. Compact by design — the agent can read $AETHON_STATE_FILE for
// the full data; this is just enough to answer "what's loaded?" without
// a tool call.
export function buildRuntimeSection(snapshot: RuntimeSnapshot): string {
  const lines: string[] = ["# Current runtime snapshot"];
  lines.push(
    `Build: ${snapshot.release ? "release" : "dev"}; cwd=\`${snapshot.cwd}\`.`,
  );
  if (snapshot.projectRoot) {
    lines.push(`Aethon source: \`${snapshot.projectRoot}\` (dev only).`);
  }
  if (snapshot.docsDir) {
    lines.push(`Docs: \`${snapshot.docsDir}\`.`);
  }
  lines.push(`State file: \`${snapshot.stateFile}\`.`);
  lines.push("");

  if (snapshot.extensions.length === 0) {
    lines.push("Loaded extensions: none.");
  } else {
    lines.push("Loaded extensions:");
    for (const ext of snapshot.extensions) {
      lines.push(`- \`${ext.name}\` (${ext.source})`);
    }
  }

  if (snapshot.themes.length > 0) {
    lines.push("");
    lines.push("Registered themes (in addition to the built-in ember / paper / aether palettes):");
    for (const t of snapshot.themes) {
      lines.push(`- \`${t.id}\` — ${t.label}`);
    }
  }

  if (snapshot.components.length > 0) {
    lines.push("");
    lines.push(
      `Registered custom A2UI component types: ${snapshot.components
        .map((c) => `\`${c}\``)
        .join(", ")}.`,
    );
  }

  if (snapshot.slashCommands.length > 0) {
    lines.push("");
    lines.push("Extension-registered slash commands:");
    for (const c of snapshot.slashCommands) {
      const usage = c.usage ? ` ${c.usage}` : "";
      lines.push(`- \`/${c.name}${usage}\` — ${c.description || "(no description)"}`);
    }
  }

  if (snapshot.keybindings.length > 0) {
    lines.push("");
    lines.push("Extension-registered keybindings (built-ins like Cmd+T / Cmd+] / Cmd+W not shown):");
    for (const k of snapshot.keybindings) {
      const desc = k.description ? ` — ${k.description}` : "";
      lines.push(`- \`${k.combo}\` → action \`${k.action}\`${desc}`);
    }
  }

  if (snapshot.menuItems.length > 0) {
    lines.push("");
    lines.push("Extension-registered menu items:");
    for (const m of snapshot.menuItems) {
      const parent = m.parent ? ` under \`${m.parent}\`` : "";
      lines.push(`- [${m.location}] \`${m.label}\` → action \`${m.action}\`${parent}`);
    }
  }

  if (snapshot.eventRoutes.length > 0) {
    lines.push("");
    lines.push(
      "Extension-intercepted event routes (these bypass App.tsx built-in handlers):",
    );
    for (const r of snapshot.eventRoutes) {
      lines.push(
        `- componentId=\`${r.componentId ?? "*"}\` eventType=\`${r.eventType ?? "*"}\``,
      );
    }
  }

  if (snapshot.eventHandlers.length > 0) {
    lines.push("");
    lines.push("Active onEvent handlers (match-shape only):");
    for (const h of snapshot.eventHandlers) {
      const parts: string[] = [];
      if (h.templateRootType) parts.push(`templateRootType=${h.templateRootType}`);
      if (h.componentType) parts.push(`componentType=${h.componentType}`);
      if (h.descendantId) parts.push(`descendantId=${h.descendantId}`);
      if (h.eventType) parts.push(`eventType=${h.eventType}`);
      lines.push(`- ${parts.length ? parts.join(", ") : "(matches everything)"}`);
    }
  }

  const uiKeys = Object.keys(snapshot.uiState);
  if (uiKeys.length > 0) {
    lines.push("");
    lines.push(
      "Frontend-mirrored state (what's currently visible — read via `aethon.getFrontendState(path)`):",
    );
    for (const key of uiKeys.sort()) {
      const value = snapshot.uiState[key];
      // Single-line JSON preview, truncated so the snapshot stays
      // skimmable. Full data lives in $AETHON_STATE_FILE.
      let preview = JSON.stringify(value);
      if (preview && preview.length > 200) {
        preview = preview.slice(0, 197) + "…";
      }
      lines.push(`- \`${key}\` = ${preview}`);
    }
  }

  lines.push("");
  lines.push(`Active layout: ${snapshot.layoutSummary}.`);
  if (snapshot.layoutStructure) {
    const ls = snapshot.layoutStructure;
    lines.push(
      `Root \`${ls.rootId}\` (\`${ls.rootType}\`) — children: ${
        ls.children
          .map((c) =>
            c.area
              ? `\`${c.id}\`(\`${c.type}\` @ ${c.area})`
              : `\`${c.id}\`(\`${c.type}\`)`,
          )
          .join(", ") || "(none)"
      }.`,
    );
  }
  if (snapshot.layoutSlots) {
    // One-liner — the full catalogue lives in the bundled
    // skills/default-layout/slots.json (and in components.md). Here we
    // just surface the slot names so the agent knows what semantic
    // areas the standard composites slot into. `area: "<name>"` on a
    // child is the contract.
    const slotNames = Object.keys(snapshot.layoutSlots.slots);
    if (slotNames.length > 0) {
      lines.push(
        `Layout slots (canonical area names): ${slotNames
          .map((n) => `\`${n}\``)
          .join(", ")}. See bundled \`components.md\` for the full contract.`,
      );
    }
  }

  if (snapshot.tabs.length > 0) {
    lines.push("");
    lines.push("Open tabs:");
    for (const t of snapshot.tabs) {
      lines.push(
        `- \`${t.id}\` — model \`${t.model || "(none)"}\`, ${t.messageCount} messages`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the Aethon system prompt fragments. Layered as:
 *   1. \`~/.aethon/system-prompt.md\` — full override (replaces DEFAULT)
 *   2. \`~/.aethon/system-prompt-append.md\` — concatenated after DEFAULT
 *   3. DEFAULT only
 *
 * The runtime snapshot is appended last in every case so the agent always
 * sees an up-to-date view of what's loaded.
 *
 * Returns the strings to append to pi's default system prompt. The bridge
 * passes these into \`DefaultResourceLoader\`'s \`appendSystemPrompt\` option
 * so they survive every resourceLoader.reload().
 */
export function resolveAethonSystemPrompt(
  snapshot: RuntimeSnapshot,
): string[] {
  const dir = join(homedir(), ".aethon");
  const overridePath = join(dir, "system-prompt.md");
  const appendPath = join(dir, "system-prompt-append.md");
  let override: string | undefined;
  let extra: string | undefined;
  try {
    override = readFileSync(overridePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-prompt] read ${overridePath}: ${(err as Error).message}`);
    }
  }
  try {
    extra = readFileSync(appendPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[aethon-prompt] read ${appendPath}: ${(err as Error).message}`);
    }
  }
  const base = override?.trim() || DEFAULT_AETHON_PROMPT;
  const runtime = buildRuntimeSection(snapshot);
  const layers = extra?.trim()
    ? [base, extra.trim(), runtime]
    : [base, runtime];
  return layers;
}
