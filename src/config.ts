// Read-only access to ~/.aethon/config.toml. Read-once cache so multiple
// callers on first paint share a single IPC. Defaults returned outside Tauri.

import { invoke } from "@tauri-apps/api/core";
import type { ShareMode } from "./utils/shareMode";
import { SHARE_MODES } from "./utils/shareMode";

export interface AethonConfig {
  ui: {
    /** Theme id from `[ui] theme = "..."`. Built-ins are
     *  `ember`, `paper`, `aether`, and `brink`; legacy `signature` maps
     *  to `aether`. Extensions can register additional ids via
     *  `aethon.registerTheme`. */
    theme: string | null;
    fontSize: number | null;
    /** When true, discovered per-tab sessions are reopened automatically
     *  on app launch instead of only appearing in the empty-state list. */
    restoreTabs: boolean;
    /** Fire a native OS notification when an agent turn finishes while
     *  the originating tab/window is unfocused. Default true. */
    notifyOnCompletion: boolean;
    /** Don't fire the completion notification for turns shorter than
     *  this many seconds. Default 8 — sub-second turns rarely need it. */
    notifyMinDurationSeconds: number;
  };
  agent: {
    model: string | null;
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
    /** What `Cmd+T` opens when focus is *outside* the bottom terminal
     *  panel: `"agent"` (default — focus-aware behaviour) or `"shell"`
     *  (Cmd+T always opens a shell sub-tab). Anything else falls
     *  through to `"agent"`. */
    newTabKind: "agent" | "shell";
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
}

const DEFAULTS: AethonConfig = {
  ui: {
    theme: null,
    fontSize: null,
    restoreTabs: false,
    notifyOnCompletion: true,
    notifyMinDurationSeconds: 8,
  },
  agent: { model: null },
  shell: {
    defaultShareMode: "private",
    autoRestartAgent: true,
    defaultCommand: null,
    defaultArgs: [],
    inheritEnv: true,
    promptBeforeClose: true,
  },
  shortcuts: { newTabKind: "agent" },
  updates: { channel: "stable", disableAutoCheck: false },
  devshell: {
    enabled: "auto",
    mode: "auto",
    cacheTtlHours: 720,
    refreshOnLockfileChange: true,
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
        },
        agent: {
          model: typeof obj?.agent?.model === "string" ? obj.agent.model : null,
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
        updates: {
          channel:
            obj?.updates?.channel === "nightly" ? "nightly" : "stable",
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

function normalizeDevshellEnabled(
  value: unknown,
): "auto" | "always" | "never" {
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
