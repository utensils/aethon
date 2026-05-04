import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { readStateWithLocalStorageFallback } from "../persist";
import { applyUiScale } from "../utils/viewport";
import { getConfig, type AethonConfig } from "../config";
import type { ShellMeta } from "../types/tab";

export interface UseBootConfigContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
}

export interface UseBootConfigActions {
  /** [shell] default_share_mode resolved from ~/.aethon/config.toml.
   *  Read once on boot and consulted by newShellTab. Defaults to
   *  `"private"` until the config loads — the safest possible seed for
   *  new shell tabs. */
  defaultShareModeRef: MutableRefObject<ShellMeta["shareMode"]>;
  /** Live config for OS notifications. Mirrors `[ui] notify_on_completion` /
   *  `notify_min_duration_seconds` and is updated on save. Held in a
   *  ref (not state) so the response_end handler reads the latest
   *  value without re-binding. */
  notifyOnCompletionRef: MutableRefObject<boolean>;
  notifyMinDurationMsRef: MutableRefObject<number>;
  /** Live config for [shell] auto_restart_agent. Read by the
   *  `agent-crashed` listener. */
  autoRestartAgentRef: MutableRefObject<boolean>;
  /** [shell] default_command / default_args / inherit_env / prompt_before_close —
   *  applied at shell_open time. Defaults track the helpers.rs schema so
   *  the first paint behaves identically to a fully-loaded config. */
  shellDefaultCommandRef: MutableRefObject<string | null>;
  shellDefaultArgsRef: MutableRefObject<string[]>;
  shellInheritEnvRef: MutableRefObject<boolean>;
  shellPromptBeforeCloseRef: MutableRefObject<boolean>;
  /** [shortcuts] new_tab_kind — controls Cmd+T routing when focus is
   *  outside the bottom terminal panel. */
  shortcutsNewTabKindRef: MutableRefObject<"agent" | "shell">;
  /** Apply a freshly-read AethonConfig into the live refs + theme/font
   *  CSS. The settings save path calls this after `clearConfigCache()`
   *  + `getConfig()` so the running app picks up the new values without
   *  a page reload. */
  reapplyConfig: (fresh: AethonConfig) => void;
}

/**
 * One-shot boot config effect: read ~/.aethon/config.toml + persisted
 * theme/zoom/sidebar-width state from disk and seed the live config
 * refs that the rest of the app consults. Runs once on mount.
 *
 * The refs are exposed so other hooks can mutate them (currently only
 * the settings save path) and read them (notify-on-completion gate,
 * shell tab defaults, agent-crashed auto-restart, Cmd+T routing).
 *
 * Held in refs (not React state) so handlers that fire from the bridge
 * see the latest values without re-binding listeners on every config
 * change.
 */
export function useBootConfig(
  ctx: UseBootConfigContext,
): UseBootConfigActions {
  const { setState } = ctx;

  const defaultShareModeRef = useRef<ShellMeta["shareMode"]>("private");
  const notifyOnCompletionRef = useRef<boolean>(true);
  const notifyMinDurationMsRef = useRef<number>(8 * 1000);
  const autoRestartAgentRef = useRef<boolean>(true);
  const shellDefaultCommandRef = useRef<string | null>(null);
  const shellDefaultArgsRef = useRef<string[]>([]);
  const shellInheritEnvRef = useRef<boolean>(true);
  const shellPromptBeforeCloseRef = useRef<boolean>(true);
  const shortcutsNewTabKindRef = useRef<"agent" | "shell">("agent");

  function reapplyConfig(fresh: AethonConfig) {
    if (fresh.ui.theme) {
      document.documentElement.dataset.theme = fresh.ui.theme;
    }
    const size = fresh.ui.fontSize;
    if (typeof size === "number" && Number.isFinite(size)) {
      const clamped = Math.max(10, Math.min(24, Math.round(size)));
      document.documentElement.style.setProperty(
        "--app-font-size",
        `${clamped}px`,
      );
    }
    defaultShareModeRef.current = fresh.shell.defaultShareMode;
    notifyOnCompletionRef.current = fresh.ui.notifyOnCompletion;
    notifyMinDurationMsRef.current =
      Math.max(0, fresh.ui.notifyMinDurationSeconds) * 1000;
    autoRestartAgentRef.current = fresh.shell.autoRestartAgent;
    shellDefaultCommandRef.current = fresh.shell.defaultCommand;
    shellDefaultArgsRef.current = fresh.shell.defaultArgs;
    shellInheritEnvRef.current = fresh.shell.inheritEnv;
    shellPromptBeforeCloseRef.current = fresh.shell.promptBeforeClose;
    shortcutsNewTabKindRef.current = fresh.shortcuts.newTabKind;
  }

  useEffect(() => {
    (async () => {
      const [saved, config] = await Promise.all([
        readStateWithLocalStorageFallback("theme", "aethon-theme"),
        getConfig(),
      ]);
      const trimmed = saved.trim();
      // Migrate legacy theme ids:
      //   - `signature` (one-theme era) → `aether`
      //   - `dark` (pre-palette-rename) → `ember`
      //   - `light` (pre-palette-rename) → `paper`
      // Without this, a saved id from an older build resolves to a
      // `data-theme="dark"` selector that no stylesheet defines, so the
      // app falls back to base ember tokens regardless of the user's
      // actual choice.
      const LEGACY_THEME_MAP: Record<string, string> = {
        signature: "aether",
        dark: "ember",
        light: "paper",
      };
      const normalize = (id: string) => LEGACY_THEME_MAP[id] ?? id;
      const prefersLight =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: light)").matches;
      const initial =
        trimmed.length > 0
          ? normalize(trimmed)
          : config.ui.theme
            ? normalize(config.ui.theme)
            : prefersLight
              ? "paper"
              : "ember";
      document.documentElement.dataset.theme = initial;
      // Apply [ui] font_size as a CSS custom property — components that
      // care can read it via var(--app-font-size, 14px). Clamped to a
      // sensible range so a malformed config can't make the UI
      // unreadable. Skipped when null so the stylesheet's default wins.
      const size = config.ui.fontSize;
      if (typeof size === "number" && Number.isFinite(size)) {
        const clamped = Math.max(10, Math.min(24, Math.round(size)));
        document.documentElement.style.setProperty(
          "--app-font-size",
          `${clamped}px`,
        );
      }
      // [shell] default_share_mode: seed the ref so subsequent
      // newShellTab calls open with the configured default. Already
      // clamped to the four valid modes by getConfig() / parse_config_toml.
      defaultShareModeRef.current = config.shell.defaultShareMode;

      // P4: notify_on_completion + notify_min_duration_seconds.
      notifyOnCompletionRef.current = config.ui.notifyOnCompletion;
      notifyMinDurationMsRef.current =
        Math.max(0, config.ui.notifyMinDurationSeconds) * 1000;
      // P5: [shell] auto_restart_agent.
      autoRestartAgentRef.current = config.shell.autoRestartAgent;
      // Extended [shell] keys.
      shellDefaultCommandRef.current = config.shell.defaultCommand;
      shellDefaultArgsRef.current = config.shell.defaultArgs;
      shellInheritEnvRef.current = config.shell.inheritEnv;
      shellPromptBeforeCloseRef.current = config.shell.promptBeforeClose;
      // [shortcuts] new_tab_kind.
      shortcutsNewTabKindRef.current = config.shortcuts.newTabKind;

      // [agent] model: when set, seed the picker default for this
      // session. Only applied if no per-session model has been saved
      // and the bridge hasn't already locked one in. The bridge's
      // ensureTab() reads the global picker default at session-create
      // time, so writing /model here makes the next set_model dispatch
      // pick it up.
      if (config.agent.model) {
        setState((prev) => ({
          ...prev,
          // Use as the initial display value; the actual session model
          // is still authoritative and wins on `ready` hydration.
          model: (prev.model) || config.agent.model!,
        }));
      }
      // Restore saved UI zoom (Cmd+/-). Stored as a string number on
      // disk; clamp to a sensible range so a stale value can't make
      // the UI unusable. applyUiScale writes both CSS zoom and the
      // --app-ui-scale token that viewport-sized containers use to
      // compensate, so zooming does not push chrome outside the window.
      const savedZoom = (
        await readStateWithLocalStorageFallback("ui_zoom", "")
      ).trim();
      const z = parseFloat(savedZoom);
      if (Number.isFinite(z) && z >= 0.7 && z <= 1.6) {
        applyUiScale(z);
      }
      // Restore saved sidebar width: patch the leading column token in
      // /layout/columns so the boot layout opens at the user's last
      // chosen width. Bail on missing/invalid values — the layout's
      // own seed wins by default.
      const savedWidth = (
        await readStateWithLocalStorageFallback("sidebar_width", "")
      ).trim();
      const px = parseInt(savedWidth, 10);
      if (Number.isFinite(px) && px >= 180 && px <= 540) {
        setState((prev) => {
          const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
          const current = (layout.columns as string | undefined) ?? "";
          if (!current) return prev;
          const tokens = current.trim().split(/\s+/);
          if (!tokens[0]?.endsWith("px")) return prev;
          tokens[0] = `${px}px`;
          return { ...prev, layout: { ...layout, columns: tokens.join(" ") } };
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    defaultShareModeRef,
    notifyOnCompletionRef,
    notifyMinDurationMsRef,
    autoRestartAgentRef,
    shellDefaultCommandRef,
    shellDefaultArgsRef,
    shellInheritEnvRef,
    shellPromptBeforeCloseRef,
    shortcutsNewTabKindRef,
    reapplyConfig,
  };
}
