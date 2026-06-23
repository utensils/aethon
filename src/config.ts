// Read-only access to ~/.aethon/config.toml. Read-once cache so multiple
// callers on first paint share a single IPC. Defaults returned outside Tauri.

import { invoke } from "@tauri-apps/api/core";
import type { ShareMode } from "./utils/shareMode";
import { SHARE_MODES } from "./utils/shareMode";

/** Tri-state visibility for the model's thinking blocks:
 *  `show` (full), `collapse` (closed "Thinking" label), `hide` (removed). */
export type VisibilityMode = "show" | "collapse" | "hide";

/** Tool-call visibility. `show` renders lightweight activity rows and `hide`
 *  removes tool calls from the transcript. The middle is split into three
 *  chronological *grouping* styles the composer pill cycles through:
 *    - `group-turn`  — one collapsed cluster per agent turn (all of a turn's
 *                      tool calls gathered into one group);
 *    - `group-run`   — one collapsed cluster per consecutive run of tool calls;
 *    - `group-block` — the whole agent turn (narration + tools) folded into one
 *                      collapsed block.
 *  The legacy `"collapse"` value (PR #204) migrates to `group-turn`. */
export type ToolCallsMode =
  | "show"
  | "group-turn"
  | "group-run"
  | "group-block"
  | "hide";

export interface AethonConfig {
  ui: {
    /** Theme id from `[ui] theme = "..."`. Built-ins are
     *  `ember`, `paper`, `aether`, and `brink`; legacy `signature` maps
     *  to `aether`. Extensions can register additional ids via
     *  `aethon.registerTheme`. */
    theme: string | null;
    fontSize: number | null;
    /** Deprecated compatibility field. Session tabs are restored
     *  unconditionally; keep this so older configs round-trip. */
    restoreTabs: boolean;
    /** Fire a native OS notification when an agent turn finishes while
     *  the originating tab/window is unfocused. Default true. */
    notifyOnCompletion: boolean;
    /** Don't fire the completion notification for turns shorter than
     *  this many seconds. Default 8 — sub-second turns rarely need it. */
    notifyMinDurationSeconds: number;
    /** Global default visibility for the model's thinking blocks. Per-tab
     *  overridable via the composer pills; `show` by default. */
    thinkingVisibility: VisibilityMode;
    /** Global default visibility for tool-call activity. The grouped values
     *  (`group-turn` / `group-run` / `group-block`) fold activity into
     *  collapsed clusters; `show` by default. Per-tab overridable via the
     *  composer pills. */
    toolCallsVisibility: ToolCallsMode;
  };
  agent: {
    model: string | null;
    /** Default reasoning effort for new sessions on models that expose it. */
    thinkingLevel: string | null;
    /** Optional Aethon-owned provider/SDK request timeout override. */
    providerTimeoutSeconds: number | null;
    /** Request Codex Fast mode (priority service tier) for supported Codex models. */
    codexFastMode: boolean;
    /** Floor applied to model-supplied bash tool timeouts. */
    bashTimeoutFloorSeconds: number;
    /** Default inline subagent wall-clock ceiling. */
    subagentTimeoutSeconds: number;
  };
  shell: {
    /** Initial share mode for new shell tabs. Defaults to `private` —
     *  the agent sees nothing until the user explicitly opts in via the
     *  status-bar badge. Configurable via `[shell] default_share_mode`. */
    defaultShareMode: ShareMode;
    /** Auto-respawn the bun bridge child on unexpected exit. Default
     *  true; configurable via `[shell] auto_restart_agent`. */
    autoRestartAgent: boolean;
    /** Override the program spawned for new shell tabs. Null/empty
     *  falls back to `$SHELL` and the platform default. */
    defaultCommand: string | null;
    /** Extra argv appended after the platform default. */
    defaultArgs: string[];
    /** Whether new shell tabs inherit the host process env. Default true. */
    inheritEnv: boolean;
    /** Confirm Cmd+W / X close when a child process is foreground.
     *  Default true. */
    promptBeforeClose: boolean;
  };
  shortcuts: {
    /** Deprecated compatibility field. Older configs may contain
     *  `[shortcuts] new_tab_kind`, so parse and round-trip it, but Cmd+T
     *  is now strictly focus-aware in the keyboard handler. */
    newTabKind: "agent" | "shell";
  };
  voice: {
    toggleHotkey: string | null;
    holdHotkey: string | null;
    /** When true, the agent's reply is spoken aloud (via the LFM2-Audio
     *  provider's text-to-speech) once a turn completes on the active tab. */
    speakAgentReplies: boolean;
    /** Upper bound on how many characters of a reply are spoken, so a long
     *  diff or log dump isn't read out in full. */
    speakMaxChars: number;
    /** In conversation voice mode, auto-reopen the mic after the agent
     *  finishes speaking (hands-free) instead of waiting for a tap. */
    conversationContinuous: boolean;
  };
  updates: {
    /** Release channel the auto-updater follows. `"stable"` (default)
     *  tracks `releases/latest`; `"nightly"` follows the `nightly`
     *  tag. Mirrored on the Rust side by `commands::updater`. */
    channel: "stable" | "nightly";
    /** When true, the 30-min background poll never runs. The "Check
     *  for Updates" menu item still works. */
    disableAutoCheck: boolean;
  };
  devshell: {
    /** Whether to detect and apply Nix devshell env on shell + agent
     *  spawn. `"auto"` (default) detects via marker files; `"always"`
     *  forces detection and errors loudly on resolver failure;
     *  `"never"` disables the feature entirely. */
    enabled: "auto" | "always" | "never";
    /** Pin a specific resolver kind, or `"auto"` for natural
     *  precedence (direnv > flake > shell). */
    mode: "auto" | "direnv" | "nix" | "nix-shell";
    /** GC ceiling for on-disk env snapshots. Default 720 h (30 days). */
    cacheTtlHours: number;
    /** Re-resolve when watched lockfile / marker file mtime changes. */
    refreshOnLockfileChange: boolean;
  };
  guardrails: {
    /** Optional advisory text appended to the per-turn working-context the
     *  agent injects. Reminds the model of project rules; never enforces.
     *  Null/empty → no anchor. From `[guardrails] soft_prompt_anchor`. */
    softPromptAnchor: string | null;
    /** When true, the agent hard-blocks write/edit/bash tool calls outside
     *  the active tab's project root. Default false. Per-tab overridable. */
    hardEnforceProjectRoot: boolean;
  };
}

export const DEFAULT_AGENT_TIMEOUT_SECONDS = 300;
export const MAX_AGENT_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_TOOL_CALLS_VISIBILITY: ToolCallsMode = "group-block";

const DEFAULTS: AethonConfig = {
  ui: {
    theme: null,
    fontSize: null,
    restoreTabs: false,
    notifyOnCompletion: true,
    notifyMinDurationSeconds: 8,
    thinkingVisibility: "show",
    toolCallsVisibility: DEFAULT_TOOL_CALLS_VISIBILITY,
  },
  agent: {
    model: null,
    thinkingLevel: null,
    providerTimeoutSeconds: null,
    codexFastMode: false,
    bashTimeoutFloorSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
    subagentTimeoutSeconds: DEFAULT_AGENT_TIMEOUT_SECONDS,
  },
  shell: {
    defaultShareMode: "private",
    autoRestartAgent: true,
    defaultCommand: null,
    defaultArgs: [],
    inheritEnv: true,
    promptBeforeClose: true,
  },
  shortcuts: { newTabKind: "agent" },
  voice: {
    toggleHotkey: "mod+shift+m",
    holdHotkey:
      typeof navigator !== "undefined" &&
      (/Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent))
        ? "AltRight"
        : null,
    speakAgentReplies: false,
    speakMaxChars: 600,
    // Auto-listen (hands-free auto-reopen of the mic after the agent speaks)
    // is opt-in: with push-to-talk the user drives each turn explicitly.
    conversationContinuous: false,
  },
  updates: { channel: "stable", disableAutoCheck: false },
  devshell: {
    enabled: "auto",
    mode: "auto",
    cacheTtlHours: 720,
    refreshOnLockfileChange: true,
  },
  guardrails: {
    softPromptAnchor: null,
    hardEnforceProjectRoot: false,
  },
};

function hasTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ===
      "object"
  );
}

let inflight: Promise<AethonConfig> | null = null;

/** Drop the in-memory config cache so the next `getConfig()` call
 *  re-reads from disk. Call after writing the config (Settings panel
 *  Save) so subsequent reads see fresh values without a page reload. */
export function clearConfigCache(): void {
  inflight = null;
}

export function getConfig(): Promise<AethonConfig> {
  if (inflight) return inflight;
  if (!hasTauri()) {
    inflight = Promise.resolve(DEFAULTS);
    return inflight;
  }
  inflight = (async () => {
    try {
      const raw = await invoke<unknown>("read_config");
      const obj = raw as Partial<AethonConfig>;
      return {
        ui: {
          theme: normalizeTheme(obj?.ui?.theme),
          fontSize:
            typeof obj?.ui?.fontSize === "number" ? obj.ui.fontSize : null,
          restoreTabs: obj?.ui?.restoreTabs === true,
          notifyOnCompletion:
            typeof obj?.ui?.notifyOnCompletion === "boolean"
              ? obj.ui.notifyOnCompletion
              : true,
          notifyMinDurationSeconds:
            typeof obj?.ui?.notifyMinDurationSeconds === "number" &&
            obj.ui.notifyMinDurationSeconds >= 0
              ? obj.ui.notifyMinDurationSeconds
              : 8,
          thinkingVisibility: normalizeVisibility(obj?.ui?.thinkingVisibility),
          toolCallsVisibility:
            obj?.ui?.toolCallsVisibility === undefined
              ? DEFAULT_TOOL_CALLS_VISIBILITY
              : normalizeToolCallsVisibility(obj.ui.toolCallsVisibility),
        },
        agent: {
          model: typeof obj?.agent?.model === "string" ? obj.agent.model : null,
          thinkingLevel: normalizeThinkingLevel(obj?.agent?.thinkingLevel),
          providerTimeoutSeconds: normalizeOptionalTimeoutSeconds(
            obj?.agent?.providerTimeoutSeconds,
          ),
          codexFastMode: obj?.agent?.codexFastMode === true,
          bashTimeoutFloorSeconds: normalizeTimeoutSeconds(
            obj?.agent?.bashTimeoutFloorSeconds,
          ),
          subagentTimeoutSeconds: normalizeTimeoutSeconds(
            obj?.agent?.subagentTimeoutSeconds,
          ),
        },
        shell: {
          defaultShareMode: normalizeShareMode(obj?.shell?.defaultShareMode),
          autoRestartAgent:
            typeof obj?.shell?.autoRestartAgent === "boolean"
              ? obj.shell.autoRestartAgent
              : true,
          defaultCommand:
            typeof obj?.shell?.defaultCommand === "string" &&
            obj.shell.defaultCommand.length > 0
              ? obj.shell.defaultCommand
              : null,
          defaultArgs: Array.isArray(obj?.shell?.defaultArgs)
            ? obj.shell.defaultArgs.filter(
                (s): s is string => typeof s === "string",
              )
            : [],
          inheritEnv:
            typeof obj?.shell?.inheritEnv === "boolean"
              ? obj.shell.inheritEnv
              : true,
          promptBeforeClose:
            typeof obj?.shell?.promptBeforeClose === "boolean"
              ? obj.shell.promptBeforeClose
              : true,
        },
        shortcuts: {
          newTabKind:
            obj?.shortcuts?.newTabKind === "shell" ? "shell" : "agent",
        },
        voice: {
          toggleHotkey:
            typeof obj?.voice?.toggleHotkey === "string"
              ? obj.voice.toggleHotkey
              : DEFAULTS.voice.toggleHotkey,
          holdHotkey:
            typeof obj?.voice?.holdHotkey === "string"
              ? obj.voice.holdHotkey
              : obj?.voice?.holdHotkey === null
                ? null
                : DEFAULTS.voice.holdHotkey,
          speakAgentReplies: obj?.voice?.speakAgentReplies === true,
          speakMaxChars:
            typeof obj?.voice?.speakMaxChars === "number" &&
            Number.isFinite(obj.voice.speakMaxChars)
              ? Math.min(
                  5000,
                  Math.max(50, Math.round(obj.voice.speakMaxChars)),
                )
              : DEFAULTS.voice.speakMaxChars,
          // Opt-in: only an explicit `true` enables auto-listen; absent or
          // false → off (matches the Rust default).
          conversationContinuous: obj?.voice?.conversationContinuous === true,
        },
        updates: {
          channel: obj?.updates?.channel === "nightly" ? "nightly" : "stable",
          disableAutoCheck: obj?.updates?.disableAutoCheck === true,
        },
        devshell: {
          enabled: normalizeDevshellEnabled(obj?.devshell?.enabled),
          mode: normalizeDevshellMode(obj?.devshell?.mode),
          cacheTtlHours:
            typeof obj?.devshell?.cacheTtlHours === "number" &&
            obj.devshell.cacheTtlHours >= 0
              ? obj.devshell.cacheTtlHours
              : 720,
          refreshOnLockfileChange:
            typeof obj?.devshell?.refreshOnLockfileChange === "boolean"
              ? obj.devshell.refreshOnLockfileChange
              : true,
        },
        guardrails: {
          softPromptAnchor:
            typeof obj?.guardrails?.softPromptAnchor === "string" &&
            obj.guardrails.softPromptAnchor.trim().length > 0
              ? obj.guardrails.softPromptAnchor
              : null,
          hardEnforceProjectRoot:
            obj?.guardrails?.hardEnforceProjectRoot === true,
        },
      };
    } catch (err) {
      console.warn("read_config failed:", err);
      return DEFAULTS;
    }
  })();
  return inflight;
}

function normalizeTheme(t: unknown): string | null {
  return typeof t === "string" && t.length > 0 ? t : null;
}

function normalizeThinkingLevel(value: unknown): string | null {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : null;
}

/** Mirrors `normalize_visibility` in helpers.rs — unknown/missing → "show". */
export function normalizeVisibility(value: unknown): VisibilityMode {
  return value === "collapse" || value === "hide" ? value : "show";
}

/** Mirrors `normalize_tool_visibility` in helpers.rs. Accepts the three
 *  grouping styles plus show/hide; legacy `"collapse"` → `"group-turn"`;
 *  unknown → `"show"` so malformed explicit config never hides content. */
export function normalizeToolCallsVisibility(value: unknown): ToolCallsMode {
  switch (value) {
    case "group-turn":
    case "group-run":
    case "group-block":
    case "hide":
      return value;
    case "collapse":
      return "group-turn";
    default:
      return "show";
  }
}

/** Mirrors `normalize_default_share_mode` in helpers.rs. Belt-and-braces:
 *  the Rust read_config command already clamps unknown values to
 *  "private", but if a future TOML revision or an in-memory mutation
 *  ships an unknown value, fall through here so the type still narrows. */
function normalizeShareMode(value: unknown): ShareMode {
  if (typeof value !== "string") return "private";
  return SHARE_MODES.includes(value as ShareMode)
    ? (value as ShareMode)
    : "private";
}

function normalizeDevshellEnabled(value: unknown): "auto" | "always" | "never" {
  if (value === "always" || value === "never") return value;
  return "auto";
}

function normalizeDevshellMode(
  value: unknown,
): "auto" | "direnv" | "nix" | "nix-shell" {
  if (value === "direnv" || value === "nix" || value === "nix-shell") {
    return value;
  }
  return "auto";
}

function normalizeOptionalTimeoutSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_AGENT_TIMEOUT_SECONDS);
}

function normalizeTimeoutSeconds(value: unknown): number {
  return (
    normalizeOptionalTimeoutSeconds(value) ?? DEFAULT_AGENT_TIMEOUT_SECONDS
  );
}
