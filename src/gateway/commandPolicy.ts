// Client-side command routing for the mobile shim. Every `invoke(cmd)`
// the reused frontend makes falls into one of three buckets before it
// would hit the network:
//
//   local     — runs against the real Tauri runtime in the mobile shell
//               (native plugins: notifications, opener). Never leaves
//               the device.
//   stub      — desktop-only commands that have no meaning on mobile;
//               answered locally with a canned value so the desktop
//               hooks that call them unconditionally don't error.
//   gateway   — forwarded to the paired desktop over the transport.
//
// Keeping this explicit (rather than "gateway by default") means a new
// desktop command surfaces as an obvious gateway call we can reason
// about, and the noisy desktop-only hooks stay quiet on the phone.

export type CommandRoute = "local" | "stub" | "gateway";

/** Native plugin commands handled by the mobile shell's own runtime. */
function isLocalPlugin(cmd: string): boolean {
  return (
    cmd.startsWith("plugin:notification|") ||
    cmd.startsWith("plugin:opener|") ||
    cmd.startsWith("plugin:barcode-scanner|")
  );
}

/** The mobile shell's own commands (WS bridge, pairing, Bonjour scan) —
 *  they must run against the local Tauri runtime, never be forwarded to
 *  the desktop they exist to reach. */
const LOCAL_PREFIXES = ["gateway_", "discovery_"];

/** Desktop-only commands stubbed with a canned value. Prefix match for
 *  the families; exact match otherwise. Terminal/files/git flows are
 *  NOT stubbed — the gateway serves them (Phase 4), so they reach the
 *  desktop like any other forwarded command. */
const STUB_PREFIXES = [
  "voice_",
  "native_window_",
  "devshell_",
  // fs watchers are desktop-local (the phone doesn't drive OS watchers);
  // fs reads/writes forward to the gateway.
  "fs_watch",
  "fs_unwatch",
  // Execution-boundary approvals stay physically at the desktop; the
  // phone treats startup as nothing-to-approve (null stub — the
  // workspace-startup hook maps it to "disabled").
  "workspace_startup_",
];

const STUB_EXACT = new Set<string>([
  "updater_available",
  "check_for_updates_with_channel",
  "install_pending_update",
  "toggle_fullscreen",
  "toggle_devtools",
  "pick_project_directory",
  // Persisted-state writes stay off the phone; config.write is the one
  // exception, translated to the gated ui.config.write forward below.
  "write_state",
  "boot_stage",
  "boot_ok",
  "set_tray_sessions",
  "set_extension_menu_items",
  // Desktop-local fs surface openers.
  "fs_reveal_in_file_manager",
  "fs_open_in_file_manager",
  "fs_open_in_default_app",
  // Git watchers are desktop-local (the phone doesn't drive OS
  // watchers). Worktree add/remove forward to the gateway so the
  // companion's issue-dispatch / new-workspace flows work end-to-end.
  "git_watch_root",
  "git_unwatch_root",
  // Extension hot-reload watchers are equally desktop-local; the
  // desktop's own webview already watches these. Forwarding them just
  // burned two guaranteed-Deny round-trips (and rate-limit slots) per
  // project announcement at boot.
  "watch_project_extensions",
  "unwatch_project_extensions",
  // Worker refresh after an extension hot toggle: the desktop webview
  // performs it; the companion receiving the broadcast must not burn a
  // doomed Deny round-trip.
  "request_worker_reloads",
  // Gateway-admin + control-plane: never driven from the phone.
  "server_status",
  "server_start",
  "server_stop",
  "remote_status",
  "remote_pairing_begin",
  "remote_pairing_cancel",
  "remote_devices_list",
  "remote_device_revoke",
  "remote_device_rename",
  "control_update_state",
  "control_request_complete",
]);

/** Canned stub results by command; anything not listed returns null. */
const STUB_RESULTS: Record<string, unknown> = {
  updater_available: false,
  write_state: null,
};

/** Commands renamed on the wire: the gateway exposes some flows as
 *  `ui.*` forwards executed by the desktop webview rather than the raw
 *  command. These keep UI-owned companion edits behind the desktop
 *  webview's single-writer boundary. */
export const GATEWAY_TRANSLATIONS: Record<string, string> = {
  set_theme: "ui.theme.set",
  write_config: "ui.config.write",
};

export function routeFor(cmd: string): CommandRoute {
  if (isLocalPlugin(cmd)) return "local";
  if (LOCAL_PREFIXES.some((p) => cmd.startsWith(p))) return "local";
  if (cmd in GATEWAY_TRANSLATIONS) return "gateway";
  if (STUB_EXACT.has(cmd)) return "stub";
  if (STUB_PREFIXES.some((p) => cmd.startsWith(p))) return "stub";
  return "gateway";
}

/** The wire command name for a gateway-routed call (applies `ui.*`
 *  translations; identity otherwise). */
export function gatewayCommand(cmd: string): string {
  return GATEWAY_TRANSLATIONS[cmd] ?? cmd;
}

export function stubResult(cmd: string): unknown {
  return cmd in STUB_RESULTS ? STUB_RESULTS[cmd] : null;
}
