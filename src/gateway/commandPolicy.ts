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
  return cmd.startsWith("plugin:notification|") || cmd.startsWith("plugin:opener|");
}

/** Desktop-only commands stubbed with a canned value. Prefix match for
 *  the families; exact match otherwise. */
const STUB_PREFIXES = [
  "voice_",
  "native_window_",
  "devshell_",
  "shell_",
  "git_",
  "gh_",
  "fs_watch",
  "fs_unwatch",
  "server_",
];

const STUB_EXACT = new Set<string>([
  "updater_available",
  "check_for_updates_with_channel",
  "install_pending_update",
  "toggle_fullscreen",
  "toggle_devtools",
  "pick_project_directory",
  "write_state",
  "write_config",
  "boot_stage",
  "boot_ok",
  "set_tray_sessions",
  "set_extension_menu_items",
  // Gateway-admin + control-plane: never driven from the phone.
  "server_status",
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
  write_config: null,
};

export function routeFor(cmd: string): CommandRoute {
  if (isLocalPlugin(cmd)) return "local";
  if (STUB_EXACT.has(cmd)) return "stub";
  if (STUB_PREFIXES.some((p) => cmd.startsWith(p))) return "stub";
  return "gateway";
}

export function stubResult(cmd: string): unknown {
  return cmd in STUB_RESULTS ? STUB_RESULTS[cmd] : null;
}
