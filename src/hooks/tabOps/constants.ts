import type { ShellMeta, Tab } from "../../types/tab";

/** Per-tab terminal buffer cap. Bash output bursts can be huge; without
 *  a ceiling the buffer would grow forever and slow tab switches as the
 *  replay payload grows. Exported so bridge / shell-output handlers
 *  outside the useTabs hook trim against the same limit. */
export const TERMINAL_REPLAY_MAX = 256 * 1024;

/** Tab fields that ride along on the root state. Bound by layout JSON
 *  via `$ref` so /messages, /draft, etc. always reflect the active
 *  tab without per-binding rewrites on every render. */
export const TAB_MIRROR_KEYS: (keyof Tab)[] = [
  "messages",
  "draft",
  "draftAttachments",
  "waiting",
  "queueCount",
  "queuedMessages",
  "queuedSteeringId",
  "canvas",
  "model",
  "contextUsage",
  "cwd",
  // M6 P1: shell-tab fields. The "kind" + "shell" mirror lets layouts
  // bind `visible: { $ref: "/kind" }`-style toggles without running a
  // full /tabs/<idx> lookup on every render.
  "kind",
  "shell",
  // Editor-tab metadata mirror — the EditorCanvas composite reads
  // /editor/filePath, /editor/language, /editor/isDirty, /editor/cursorLine
  // via $ref so the status strip + dirty dot reflect the active editor
  // tab without a /tabs/<idx>/editor walk per render.
  "editor",
];

/** Closed-tab undo stack ceiling. The most-recent 10 closed tabs are
 *  reopenable via Cmd+Shift+T; older entries fall off so an open-and-
 *  close storm can't grow the ref unboundedly. */
export const CLOSED_TAB_STACK_MAX = 10;

/** ShareMode values accepted by `applyShareModeToTab`. Mirrors the Rust
 *  `ShareMode` enum (shell/sharemode.rs); kept in sync by hand because a
 *  full TS-side codegen pipeline isn't worth it for four values. */
export const VALID_SHARE_MODES: ShellMeta["shareMode"][] = [
  "private",
  "read",
  "read-write",
  "read-write-trusted",
];
