export interface RuntimeSnapshot {
  release: boolean;
  cwd: string;
  docsDir: string | undefined;
  projectRoot: string | undefined;
  userDir: string;
  stateFile: string;
  extensions: {
    name: string;
    source:
      | "directory"
      | "project-directory"
      | "extension-package"
      | "pi-extension";
    projectRoot?: string;
  }[];
  // Extensions that failed to load (parse / runtime error during import or
  // register()) or were skipped (missing register export, missing
  // aethon.entry, etc). Populated by the bridge's extension loaders alongside
  // `loadedExtensions`. The agent reads this so it knows when an extension
  // it just wrote did not actually take effect — without this field the
  // failure was visible only to the user as a chat-side SYSTEM banner, and
  // the agent had to ask "did it load?" or scrape stderr to find out.
  // Cleared per-name when the same extension successfully loads later.
  failedExtensions: {
    name: string;
    source: "directory" | "project-directory" | "extension-package";
    status: "failed" | "skipped";
    error: string;
    path?: string;
    projectRoot?: string;
  }[];
  // Extensions the user has explicitly disabled via the sidebar
  // right-click menu. Persisted at `<userDir>/disabled-extensions.json`
  // and consulted by the loader on every boot. The agent should respect
  // user intent — if a disabled extension is also in `extensions`, the
  // toggle landed mid-session and a restart is needed for it to fully
  // unload.
  disabledExtensions: string[];
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
  // extensions) are NOT included here — they're in the frontend's static
  // catalog; this is the extension delta only.
  slashCommands: { name: string; description: string; usage?: string }[];
  // Pi slash commands discovered from the live pi session. Includes
  // user/project extension commands, prompt templates, and skill commands
  // such as /skill:name. These pass through to pi's normal prompt router.
  piSlashCommands?: {
    name: string;
    description: string;
    usage?: string;
    source?: "extension" | "prompt" | "skill";
  }[];
  // Pi skills discovered under ~/.pi/agent/skills. The frontend surfaces
  // these as passthrough slash-command completions; execution is still
  // handled by pi's normal skill routing.
  piSkills?: { name: string; description: string; usage?: string }[];
  // Extension-registered keyboard shortcuts (combo + action + optional
  // description). Built-ins (Cmd+T / Cmd+Shift+] / Cmd+Shift+[ / Cmd+W / Cmd+`) are
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
  eventRoutingMode: "builtin" | "extension";
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
  // Extension-registered layouts — the layout catalogue the agent can
  // append to via `aethon.registerLayout`. Built-in layouts shipped by
  // the default-layout extension (workstation, editorial, command-deck,
  // live-layout) are NOT listed here; this is the extension delta only.
  // Payloads are NOT included — they can be large; the agent calls
  // `getLayout()` after activation if it needs the structure.
  layouts: { id: string; name: string; description?: string }[];
  // Extension packages whose `aethon.frontendEntry` shipped a React
  // module to the webview (file body wrapped with `new Function("React",
  // "extension", code)` and run on the frontend). `bytes` is the source
  // size — useful for the agent to spot oversized modules; the actual
  // code body is NOT in the snapshot.
  frontendModules: { name: string; entryPath: string; bytes: number }[];
}
