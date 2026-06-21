/**
 * Shared mutable state for the Aethon agent bridge.
 *
 * Hoisted out of `main()` so helpers can be extracted into focused modules
 * (extension-loader.ts, mutation-ack.ts, layout-manager.ts, ...) instead of
 * sharing closure state with a single 4k-line `main()`. The class is a
 * **pure data holder** — no IO, no side effects. Side effects (`send`,
 * `scheduleStateFileWrite`, `makeCanvasApi`) are kept separate and passed
 * to helpers as deps, so state.ts has zero IO and is trivial to instantiate
 * in tests.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import type { BashTerminalStreamState } from "./terminal-stream";
import type { AuthProfileServices, AuthProfilesState } from "./auth-profiles";

// ---------------------------------------------------------------------------
// Shared types — extracted from the original main.ts
// ---------------------------------------------------------------------------

export type ExtensionSource =
  | "directory"
  | "project-directory"
  | "extension-package"
  | "pi-extension";

export type ExtensionFailureSource = Extract<
  ExtensionSource,
  "directory" | "project-directory" | "extension-package"
>;

export interface ExtensionFailure {
  source: ExtensionFailureSource;
  status: "failed" | "skipped";
  error: string;
  path?: string;
  projectRoot?: string;
}

export interface ThemeRecord {
  id: string;
  label: string;
  vars: Record<string, string>;
}

export interface MutationResult {
  ok: boolean;
  /** Frontend-reported reason on failure. Common values:
   *  - "frontend_rejected: <detail>" — explicit ack failure
   *  - "timeout"                      — no ack within MUTATION_ACK_TIMEOUT_MS
   *  - "frontend_disconnected"        — bridge died mid-flight
   */
  error?: string;
  /** Optional payload for query-style mutations (e.g. `aethon.shells.list`,
   *  `aethon.shells.read`). The shape is op-specific — see the namespace
   *  that produced the result. Null for plain side-effect mutations. */
  data?: unknown;
}

/** The API surface extensions receive in their `register(api)` call.
 *
 *  Aliased to the full `AethonApi` (the same object installed on
 *  `globalThis.aethon`) because there is no real sandbox between the
 *  bridge and an extension — they share a Bun runtime and could reach
 *  `globalThis.aethon` directly anyway. The previous narrow 4-method
 *  shim caused `api.registerSidebarSection is not a function` errors
 *  for extensions that followed the documented contract.
 *
 *  Imported as `import type` to keep this circular-import safe — types
 *  are erased at runtime. */
import type { AethonApi } from "./aethon-api";
export type AethonExtensionApi = AethonApi;

import type { LoadSubagentsResult } from "./subagents/types";
import { DEFAULT_AGENT_TIMEOUT_SECONDS } from "./runtime-config";

export interface AethonExtensionModule {
  register?: (api: AethonExtensionApi) => void | Promise<void>;
  default?: { register?: (api: AethonExtensionApi) => void | Promise<void> };
}

export interface LayoutSlotsCatalogue {
  version: number;
  description: string;
  slots: Record<
    string,
    { description: string; defaultComposite: string; required: boolean }
  >;
}

export interface RegisteredEventRoute {
  componentId?: string;
  eventType?: string;
}

export interface RegisteredMenuItem {
  id: string;
  label: string;
  action: string;
  location: "app" | "tray";
  parent?: string;
}

export interface RegisteredKeybinding {
  combo: string;
  action: string;
  description?: string;
}

export interface RegisteredSlashCommand {
  name: string;
  description: string;
  usage?: string;
}

export interface RegisteredPiSkill {
  name: string;
  description: string;
  usage?: string;
}

export interface RegisteredPiSlashCommand {
  name: string;
  description: string;
  usage?: string;
  source?: "extension" | "prompt" | "skill";
  sourceInfo?: unknown;
}

export interface RegisteredLayout {
  id: string;
  name: string;
  description?: string;
  payload: Record<string, unknown>;
}

export interface FrontendModule {
  name: string;
  entryPath: string;
  code: string;
}

export interface RegisteredHighlightGrammar {
  lang: string;
  grammar: unknown;
}

export interface DiscoveredTab {
  tabId: string;
  lastModified: number;
  cwd?: string;
  /** false when `cwd` is set but the directory no longer exists on disk
   *  (e.g. a deleted workspace/worktree). Absent when cwd is unset. */
  cwdExists?: boolean;
  firstUserMessage?: string;
  /** User-supplied label (via the sidebar "Rename session…" action).
   *  When present, the sidebar shows this instead of `firstUserMessage`.
   *  Persisted at `<sessionsDir>/<tabId>/label.txt`. */
  customLabel?: string;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
  thinkingLevels?: string[];
  codexFastModeSupported?: boolean;
}

export interface A2UIEventMatch {
  templateRootType?: string;
  componentType?: string;
  descendantId?: string;
  eventType?: string;
  surfaceId?: string;
  windowId?: string;
}

export interface A2UIEventInfo {
  componentId?: string;
  componentType?: string;
  templateRootType?: string;
  eventType?: string;
  surfaceId?: string;
  windowId?: string;
  data?: unknown;
}

/** Narrow facade pi handler ctx — see main.ts comment block for rationale. */
export interface PiHandlerCtx {
  prompt(text: string): Promise<void>;
  notify(message: string): void;
  readonly session: {
    readonly model: string;
    readonly messages: ReadonlyArray<unknown>;
  };
  readonly signal: AbortSignal | undefined;
}

/** Will be re-exported from aethon-api.ts; declared here to break the
 *  cycle between TabRecord (defined alongside session subscribers that
 *  reference the AethonApi type) and aethon-api.ts.
 *  Helpers that need the full AethonApi shape import it from aethon-api.ts;
 *  this loose type is just the structural shape used by handler ctx. */
export type AethonApiLike = Record<string, unknown>;

export interface NativeCanvasWindowSummary {
  id: string;
  label: string;
  kind: "canvas";
  title: string;
  tabId?: string;
  restoreOnLaunch?: boolean;
  componentCount?: number;
}

export interface AethonWindowHandlerCtx {
  id: string;
  setState(path: string, value: unknown): Promise<MutationResult>;
  emit(components: unknown): Promise<MutationResult>;
  append(components: unknown): Promise<MutationResult>;
  patch(path: string, value: unknown): Promise<MutationResult>;
  clear(): Promise<MutationResult>;
  setTitle(title: string): Promise<MutationResult>;
  focus(): Promise<MutationResult>;
  close(): Promise<MutationResult>;
}

export type A2UIEventHandler = (
  event: A2UIEventInfo,
  ctx: {
    setState: (path: string, value: unknown) => Promise<MutationResult>;
    registerComponent: (
      componentType: string,
      template: unknown,
    ) => Promise<MutationResult>;
    pi: PiHandlerCtx;
    canvas: AethonApiLike;
    shells: AethonApiLike;
    windows: AethonApiLike;
    window?: AethonWindowHandlerCtx;
  },
) => void | Promise<void>;

/** Per-tab record — kept inside the state class so helpers can iterate
 *  over `state.tabs` to flush per-turn caches, abort sessions, etc. */
export interface TabRecord {
  id: string;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  toolArgsCache: Map<
    string,
    {
      name: string;
      summary: string;
      uiId: string;
      args?: unknown;
      rootPath?: string;
      bashStream?: BashTerminalStreamState;
      taskPartialStream?: BashTerminalStreamState;
      /** Epoch ms — when tool_execution_start fired. Used by the M6 P4
       *  `tool-card` component to render a live elapsed-time clock. */
      startedAt?: number;
      /** Epoch ms — when Aethon synthesized a terminal state before pi
       *  emitted tool_execution_end (e.g. user pressed Stop). */
      endedAt?: number;
      status?: "cancelled";
    }
  >;
  promptInFlight: boolean;
  agentEndFired: boolean;
  queuedCount: number;
  toolCardSeq: number;
  /** Synthetic assistant message id currently receiving streamed text /
   *  thinking deltas. Cleared at tool boundaries so post-tool deltas land
   *  after the tool card instead of amending an earlier bubble. */
  activeResponseMessageId?: string;
  /** Canonical pi id (when present) for the active streamed segment. */
  activeResponseCanonicalId?: string;
  /** Text streamed into the active response segment. Used to reconcile
   *  missing final content from agent_end without duplicating deltas. */
  activeResponseText?: string;
  /** Thinking/reasoning streamed into the active response segment. */
  activeResponseThinking?: string;
  /** Monotonic per-tab counter used to make synthetic response ids unique
   *  without trusting pi message_update timestamps (which can refer to an
   *  earlier transcript record during streaming). */
  responseMessageSeq: number;
  /** Aethon-side retry fallback for retryable agent_end errors that the SDK
   *  reports without driving its own auto-retry event sequence. */
  aethonRetryAttempt?: number;
  aethonRetryInFlight?: boolean;
  aethonRetryTimer?: ReturnType<typeof setTimeout>;
  /** Context-overflow recovery state for provider errors that need a
   *  compact-and-resume turn instead of surfacing as terminal failures. */
  contextOverflowRecoveryAttempted?: boolean;
  contextOverflowRecoveryInFlight?: boolean;
  contextOverflowRecoveryCompactionStarted?: boolean;
  contextOverflowRecoveryFallbackRunning?: boolean;
  contextOverflowRecoveryTimer?: ReturnType<typeof setTimeout>;
  contextOverflowRecoveryErrorMessage?: string;
  /** Auth profile ids already tried by the usage-limit auto-switch for the
   *  current prompt. Prevents looping back onto an account we just bounced
   *  off; cleared on the next successful (non-error) turn. */
  autoSwitchTried?: Set<string>;
  /** Current Rust-scheduled task run, when this prompt was fired by
   *  Aethon's native scheduler instead of direct user input. */
  scheduledRun?: {
    taskId: string;
    runId: string;
    wakeupScheduled?: boolean;
    completeRequested?: boolean;
  };
  /** Live context-meter estimate for text/tool output that has streamed
   *  in this turn but has not yet landed in pi's authoritative usage. */
  contextUsageTransientTokens?: number;
  contextUsageLastEmitMs?: number;
  contextUsageEmitTimer?: ReturnType<typeof setTimeout>;
}

export interface ProjectBaselineSnapshot {
  components: Map<string, unknown>;
  themes: Map<string, ThemeRecord>;
  slashCommands: Map<string, RegisteredSlashCommand>;
  keybindings: Map<string, RegisteredKeybinding>;
  menuItems: Map<string, RegisteredMenuItem>;
  layouts: Map<string, RegisteredLayout>;
  eventRoutes: Map<string, RegisteredEventRoute>;
  eventRoutingMode: "builtin" | "extension";
  eventHandlerCount: number;
  /** Insertion-ordered snapshot of the dedupe set used by `_onEvent`.
   *  Without restoring this, switching back to a project causes its
   *  `register()` to silently no-op on every onEvent call (the key is
   *  still in the set even though the handler was trimmed). */
  handlerDedupeKeys: string[];
  stateTree: Record<string, unknown>;
  /** JSON Pointer paths written by non-project extensions. Restoring this
   *  lets the frontend prune project-only state slices on the next hydrate. */
  stateKeys: string[];
  frontendModules: Map<string, FrontendModule>;
  highlightGrammars: Map<string, RegisteredHighlightGrammar>;
  /** Active extension-supplied layout (full replacement). Cloned so a
   *  later patchLayout doesn't mutate the snapshot in place. */
  extensionLayout: unknown;
  /** Pending patches against the boot layout (what's queued when no
   *  setLayout has been called). Cloned for the same reason. */
  pendingLayoutPatches: { path: string; value: unknown }[];
}

export interface PendingMutation {
  resolve: (r: MutationResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Configuration + state class
// ---------------------------------------------------------------------------

export interface AethonAgentStateOptions {
  userDir: string;
  stateFile: string;
  sessionsDir: string;
  docsDir: string | undefined;
  projectRoot: string | undefined;
  releaseMode: boolean;
  bootLayoutFile: string | undefined;
  layoutSlotsFile: string | undefined;
  /** Hard cap (bytes) on a single setState payload. Beyond this the
   *  bridge rejects. Comes from $AETHON_STATE_HARD_KB \* 1024. */
  statePayloadHardBytes: number;
  /** Soft warn threshold (bytes) on a single setState payload. Below
   *  this the bridge stays quiet; in between it logs (rate-limited).
   *  Comes from $AETHON_STATE_WARN_KB \* 1024. */
  statePayloadWarnBytes: number;
  statePayloadWarnKb: number;
  statePayloadHardKb: number;
  providerTimeoutMs?: number;
  codexFastMode?: boolean;
  bashTimeoutFloorSeconds?: number;
  subagentTimeoutSeconds?: number;
}

/**
 * Mutable shared state for the Aethon agent bridge.
 *
 * Field naming convention:
 *  - `readonly` for collections that mutate in place (Maps/Sets/Arrays
 *    — readers know the *reference* never changes; writers `.set()`/`.push()`).
 *  - bare fields for scalars/objects that get re-assigned (`extensionLayout`,
 *    `eventRoutingMode`, `currentAgentTabId`, ...). Direct assignment from
 *    extracted helpers preserves the original closure semantics exactly.
 *
 * The class deliberately has no methods that perform IO — `send` /
 * `scheduleStateFileWrite` / `makeCanvasApi` etc. live outside and are
 * passed to helpers as deps. This keeps state.ts trivial to instantiate
 * in unit tests (no stdout, no filesystem, no Tauri).
 */
export class AethonAgentState {
  // -- Configuration (read-only at boot) -----------------------------------
  readonly userDir: string;
  readonly stateFile: string;
  readonly sessionsDir: string;
  readonly docsDir: string | undefined;
  readonly projectRoot: string | undefined;
  readonly releaseMode: boolean;
  readonly bootLayoutFile: string | undefined;
  readonly layoutSlotsFile: string | undefined;
  readonly statePayloadWarnBytes: number;
  readonly statePayloadHardBytes: number;
  readonly statePayloadWarnKb: number;
  readonly statePayloadHardKb: number;
  /** Optional Aethon-owned provider request timeout override, in ms. */
  providerTimeoutMs: number | undefined;
  /** Whether to request Codex's priority service tier for supported models. */
  codexFastMode: boolean;
  /** Floor applied to model-supplied bash tool timeouts, in seconds. */
  bashTimeoutFloorSeconds: number;
  /** Default wall-clock ceiling for inline subagent runs, in seconds. */
  subagentTimeoutSeconds: number;

  // -- Service singletons (set by main() once pi is up) --------------------
  authStorage!: AuthStorage;
  modelRegistry!: ModelRegistry;
  settingsManager!: SettingsManager;
  resourceLoader!: DefaultResourceLoader;
  authProfiles: AuthProfilesState = {
    version: 1,
    profiles: [],
    defaultByProvider: {},
  };
  readonly authProfileServices = new Map<string, AuthProfileServices>();

  // -- Layout (loaded synchronously at boot from $AETHON_BOOT_LAYOUT_FILE) -
  bootLayout: unknown = undefined;
  layoutSlotsCatalogue: LayoutSlotsCatalogue | undefined = undefined;

  // -- Tabs / sessions -----------------------------------------------------
  readonly tabs = new Map<string, TabRecord>();
  readonly tabProjectCwds = new Map<string, string>();
  readonly tabAuthProfileIds = new Map<string, string>();
  /** Per-tab hard project-root guardrail override. When unset for a tab, the
   *  source guard falls back to {@link hardEnforceProjectRootDefault}. Set from
   *  the `hardEnforce` field that rides each `chat` message (the frontend's
   *  per-tab toggle), so it's always current before a turn's tool calls and
   *  survives an agent respawn. Read live by the wrapWithSourceGuard closure. */
  readonly tabHardEnforce = new Map<string, boolean>();
  /** Per-tab plan mode. When true, the source guard blocks mutating tools
   *  while still allowing read/introspection so the model can inspect and
   *  propose a plan. Carried on every chat from the frontend and read live by
   *  the wrapWithSourceGuard closure. */
  readonly tabPlanMode = new Map<string, boolean>();
  /** Global default for the hard project-root guardrail, from
   *  `[guardrails] hard_enforce_project_root` via the
   *  AETHON_HARD_ENFORCE_PROJECT_ROOT env at spawn. */
  hardEnforceProjectRootDefault = false;
  /** Tab whose pi turn is currently running. Set when a chat / handler
   *  prompt is dispatched; cleared on agent_end. Used by setState so
   *  direct globalThis.aethon.setState calls from the agent or extensions
   *  reacting to agent events get attributed to the right tab. */
  currentAgentTabId: string | undefined = undefined;
  /** Cwd we last loaded project extensions for. Null until first load.
   *  Initial null is load-bearing — set_project / tab_open compare against
   *  it to decide whether the project changed. */
  currentProjectCwd: string | null = null;
  /** Per-tab wall-clock turn start times. Set in agent_start, consumed in
   *  agent_end to compute durationMs. */
  readonly turnStartTimes = new Map<string, number>();
  /** Session/message ids already emitted through aethon.sessions events.
   *  Lets local transcript persistence skip duplicate append events for
   *  assistant bubbles that were already announced while streaming. */
  readonly emittedSessionMessageIds = new Set<string>();
  /** Cached model picker. First populated when the default tab is created. */
  cachedModels: ModelDescriptor[] = [];

  // -- Subagents -----------------------------------------------------------
  /** Per-cwd subagent registry cache (user scope + that project's scope,
   *  merged project-wins-by-name), keyed by project cwd ("" = user-only).
   *  Lazily populated by `getSubagentsForCwd` and cleared by `refreshSubagents`
   *  when the UI edits a definition. Keying by cwd keeps subagents correct when
   *  tabs on different projects are open simultaneously. */
  readonly subagentsByCwd = new Map<string, LoadSubagentsResult>();
  /** One-shot per-tab steer: when the user opens a message with leading
   *  `@<name>` mentions matching known subagents, the tabId → invocation is recorded here and the
   *  `before_agent_start` hook consumes (and clears) it to strongly steer the
   *  model to delegate. One-shot + clear prevents the subagent's own turn from
   *  re-triggering delegation. */
  readonly pendingExplicitSubagent = new Map<
    string,
    { names: string[]; surface: "inline" | "background" }
  >();
  /** Persisted per-tab session directories discovered at boot. Shipped
   *  in `ready` so the frontend can offer "Recent sessions". */
  discoveredTabs: DiscoveredTab[] = [];

  /** Per-turn tabId propagated through the async call chain that runs
   *  inside session.prompt(). Concurrent prompts on different tabs each
   *  get their own store. */
  readonly tabContext = new AsyncLocalStorage<string>();

  // -- Extension registries ------------------------------------------------
  readonly extensionComponents = new Map<string, unknown>();
  /** Themes registered by extensions, keyed by id. Insertion order is
   *  preserved so the sidebar shows them in registration order. */
  readonly extensionThemes = new Map<string, ThemeRecord>();
  /** State tree set by extension setState. Re-assigned on every write
   *  (immutable updates via setAtPointer). */
  extensionStateTree: Record<string, unknown> = {};
  /** Every JSON Pointer path written via extension setState (excluding
   *  per-tab mirrored slices). Reported in the `ready` snapshot so the
   *  frontend can wipe stale slices when an extension is uninstalled. */
  readonly extensionStateKeys = new Set<string>();
  /** Per-tab mirrored-key writes (canvas / messages / draft / waiting /
   *  queueCount / model). Kept separate from extensionStateTree so a
   *  webview reload's `ready` can replay each tab's UI state without
   *  smearing one tab's writes into another. */
  readonly perTabExtState = new Map<string, Record<string, unknown>>();
  /** Latest extension-supplied layout (set by setLayout, mutated by
   *  patchLayout). Retained so a webview reload's `report` → `ready`
   *  re-emits it instead of falling back to the boot layout. `undefined`
   *  means no extension has overridden the default layout. */
  extensionLayout: unknown = undefined;
  /** Patches applied via patchLayout when no extensionLayout has been set
   *  yet — they target the default layout. Retained as an ordered list so
   *  reload-replay applies them in the same sequence. */
  pendingLayoutPatches: { path: string; value: unknown }[] = [];
  readonly extensionEventRoutes = new Map<string, RegisteredEventRoute>();
  eventRoutingMode: "builtin" | "extension" = "builtin";
  readonly extensionMenuItems = new Map<string, RegisteredMenuItem>();
  readonly extensionKeybindings = new Map<string, RegisteredKeybinding>();
  readonly extensionSlashCommands = new Map<string, RegisteredSlashCommand>();
  piSlashCommands: RegisteredPiSlashCommand[] = [];
  piSkills: RegisteredPiSkill[] = [];
  readonly extensionLayouts = new Map<string, RegisteredLayout>();
  readonly extensionFrontendModules = new Map<string, FrontendModule>();
  readonly extensionHighlightGrammars = new Map<
    string,
    RegisteredHighlightGrammar
  >();
  readonly nativeWindows = new Map<string, NativeCanvasWindowSummary>();
  /** Extension subscriptions registered through `aethon.sessions.on(...)`.
   *  Kept loosely typed here to avoid a state.ts -> aethon-api-sessions.ts
   *  runtime cycle; the API module narrows event names/payloads. */
  readonly sessionEventHandlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >();
  readonly a2uiEventHandlers: {
    match: A2UIEventMatch;
    handler: A2UIEventHandler;
  }[] = [];
  /** Pi may re-run extension register() per session, and `tabs` create
   *  sessions on demand — so without dedup, every new tab would re-add
   *  every extension handler, multiplying side effects on each click. */
  readonly registeredHandlerKeys = new Set<string>();

  // -- Loading state -------------------------------------------------------
  readonly loadedExtensions = new Map<string, ExtensionSource>();
  readonly projectExtensionRoots = new Map<string, string>();
  readonly loadFailures = new Map<string, ExtensionFailure>();
  /** Extension display-names the user has explicitly disabled. Persisted
   *  on disk at `<userDir>/disabled-extensions.json` and consulted by
   *  the loader to skip imports. The displayName is the same string the
   *  sidebar shows (e.g. `mold:image-gallery`, `my-user-ext`). */
  readonly disabledExtensions = new Set<string>();
  /** Source + projectRoot for each disabled name, captured at toggle
   *  time from the live loader registries. Lets the frontend scope
   *  project-directory disabled rows to the active project (so a
   *  `mold:image-gallery` disabled in mold doesn't appear under
   *  Claudette). Empty for legacy on-disk entries that predate the
   *  enriched format — those entries are treated as global and show
   *  everywhere until the user re-toggles them. */
  readonly disabledExtensionMeta = new Map<
    string,
    { source: ExtensionSource; projectRoot?: string }
  >();
  readonly loadedProjectExtensionFiles = new Set<string>();
  /** Project extension files we already tried to load and that errored.
   *  Tracked separately from `loadedProjectExtensionFiles` so we don't
   *  re-import (and re-warn about) the same broken file on every
   *  `tab_open` / `set_project` for the same project. Cleared by
   *  `unloadProjectExtensions`, so switching projects does retry. */
  readonly failedProjectExtensionFiles = new Set<string>();
  readonly projectExtensionTeardowns: Array<() => void | Promise<void>> = [];
  readonly userExtensionTeardowns: Array<() => void | Promise<void>> = [];
  /** Tracks which extension scope's register() is currently on the stack.
   *  Project-directory teardowns fire when the active project changes;
   *  user-level (or out-of-register()) teardowns persist for the lifetime
   *  of the bridge. */
  currentExtensionLoadScope: "user" | "project" | null = null;
  /** Display name of the extension whose register() is currently on the
   *  stack. Set for the duration of register(). Used by setState's size
   *  guard so the WARN names the offending extension. */
  currentExtensionName: string | null = null;
  /** setInterval-driven setState calls run *after* register() returns, so
   *  currentExtensionName has already reset to null. We remember the last
   *  extension we saw write to each path so async callbacks still get
   *  attributed to the right extension. */
  readonly extPathOwners = new Map<string, string>();
  /** Keys (`${ext}|${kind}|${path}`) we've already surfaced as a
   *  user-facing `extension_runtime_error` event. We notify once per
   *  problem and rely on the log-throttler for ongoing visibility. The
   *  key is cleared when the same path receives a successful setState,
   *  so a recovered-then-broken extension re-notifies. */
  readonly notifiedExtRuntimeErrors = new Set<string>();
  projectBaseline: ProjectBaselineSnapshot | null = null;

  // -- Mutation acks / handshake ------------------------------------------
  readonly pendingMutations = new Map<string, PendingMutation>();
  /** True once the frontend has reported `ready`. Mutations made before
   *  this resolve immediately with {ok:true} on the assumption that
   *  retained-state replay will deliver them. */
  frontendReady = false;
  readonly frontendReadyResolvers: Array<() => void> = [];
  readonly frontendReadyPromise: Promise<void>;
  mutationCounter = 0;
  notificationCounter = 0;

  // -- State-file persistence (debounced writes) --------------------------
  stateFileTimer: ReturnType<typeof setTimeout> | null = null;
  stateFileWriting = false;
  stateFileDirty = false;

  // -- Frontend state mirror ----------------------------------------------
  /** Bridge-readable mirror of frontend-populated state slices. The
   *  frontend pushes `frontend_state_patch { path, value }` whenever an
   *  allowlisted slice changes (models, themes, connection, status, tabs,
   *  draft, messagesCount). */
  readonly frontendState = new Map<string, unknown>();

  // -- Hot-reload coordination --------------------------------------------
  /** Set when the Rust file watcher sends `reload_request`. The bridge
   *  drains in-flight prompts then exits cleanly so the supervisor can
   *  respawn it with fresh extensions on the next request — instead of
   *  the watcher SIGKILLing mid-prompt. */
  reloadPending = false;

  constructor(opts: AethonAgentStateOptions) {
    this.userDir = opts.userDir;
    this.stateFile = opts.stateFile;
    this.sessionsDir = opts.sessionsDir;
    this.docsDir = opts.docsDir;
    this.projectRoot = opts.projectRoot;
    this.releaseMode = opts.releaseMode;
    this.bootLayoutFile = opts.bootLayoutFile;
    this.layoutSlotsFile = opts.layoutSlotsFile;
    this.statePayloadWarnBytes = opts.statePayloadWarnBytes;
    this.statePayloadHardBytes = opts.statePayloadHardBytes;
    this.statePayloadWarnKb = opts.statePayloadWarnKb;
    this.statePayloadHardKb = opts.statePayloadHardKb;
    this.providerTimeoutMs = opts.providerTimeoutMs;
    this.codexFastMode = opts.codexFastMode ?? false;
    this.bashTimeoutFloorSeconds =
      opts.bashTimeoutFloorSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
    this.subagentTimeoutSeconds =
      opts.subagentTimeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS;

    this.frontendReadyPromise = new Promise((resolve) => {
      this.frontendReadyResolvers.push(resolve);
    });
  }

  // ---- Helpers tied to the few re-assigned scalars ----------------------
  /** Per-process random token baked into every mutationId. The Rust
   *  supervisor routes acks by mutationId across ALL bridge processes
   *  (global + per-tab workers); without this, two workers minting ids
   *  in the same millisecond at the same counter value would collide
   *  and cross-route their acks. */
  private readonly mutationIdSeed = Math.random().toString(36).slice(2, 8);

  /** Generate the next mutationId. Mutates `mutationCounter`. */
  nextMutationId(): string {
    this.mutationCounter += 1;
    return `m${Date.now().toString(36)}-${this.mutationIdSeed}-${this.mutationCounter}`;
  }

  nextNotificationId(): string {
    this.notificationCounter += 1;
    return `n${Date.now().toString(36)}-${this.notificationCounter}`;
  }
}

/** Narrow service-shaped subset of {@link AethonAgentState} useful for
 *  helpers that only need the pi-coding-agent objects. */
export interface PiServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
}

/** Helper to assemble a {@link PiServices} subset from a state instance. */
export function piServicesOf(state: AethonAgentState): PiServices {
  return {
    authStorage: state.authStorage,
    modelRegistry: state.modelRegistry,
    settingsManager: state.settingsManager,
    resourceLoader: state.resourceLoader,
  };
}

/** Sentinel for unused Model param to avoid an empty-import lint hit. */
export type _ModelHelperRef = Model<Api>;
