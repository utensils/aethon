import { describe, expect, it } from "vitest";

import { gatewayCommand, routeFor, stubResult } from "./commandPolicy";

describe("mobile command policy", () => {
  it("routes native plugin commands locally", () => {
    expect(routeFor("plugin:notification|notify")).toBe("local");
    expect(routeFor("plugin:opener|open_url")).toBe("local");
    expect(routeFor("plugin:barcode-scanner|scan")).toBe("local");
  });

  it("routes the mobile shell's own commands locally, never to the desktop", () => {
    for (const cmd of [
      "gateway_connect",
      "gateway_send",
      "gateway_close",
      "gateway_pair",
      "discovery_scan",
    ]) {
      expect(routeFor(cmd)).toBe("local");
    }
  });

  it("stubs desktop-only command families", () => {
    for (const cmd of [
      "voice_start_recording",
      "native_window_open_canvas",
      "devshell_status",
      "fs_watch_dirs",
      "fs_open_in_default_app",
      "git_worktree_add",
      "git_watch_root",
      "updater_available",
      "write_state",
      "toggle_devtools",
      "pick_project_directory",
      // Gateway-admin / control-plane never drive from the phone.
      "server_status",
      "remote_pairing_begin",
      "remote_status",
      "control_update_state",
    ]) {
      expect(routeFor(cmd)).toBe("stub");
    }
  });

  it("forwards the chat + read + terminal/files/git surface to the gateway", () => {
    for (const cmd of [
      "send_message",
      "agent_command",
      "dispatch_a2ui_event",
      "start_agent",
      "read_state",
      "read_config",
      "search_sessions",
      "fork_session",
      "host_info",
      // Phase 4 surfaces now reach the desktop over the gateway.
      "shell_open",
      "shell_input",
      "git_status",
      "gh_repo_overview",
      "fs_read_file",
      "fs_list_dir",
    ]) {
      expect(routeFor(cmd)).toBe("gateway");
    }
  });

  it("translates explicit UI-owned mutations to gated frontend forwards", () => {
    // Routed to the gateway (not stubbed) but under the ui.* method the
    // desktop webview applies + persists.
    expect(routeFor("write_config")).toBe("gateway");
    expect(gatewayCommand("write_config")).toBe("ui.config.write");
    expect(routeFor("set_theme")).toBe("gateway");
    expect(gatewayCommand("set_theme")).toBe("ui.theme.set");
    // Untranslated commands keep their name.
    expect(gatewayCommand("send_message")).toBe("send_message");
  });

  it("gives updater_available a falsey stub and unknown stubs null", () => {
    expect(stubResult("updater_available")).toBe(false);
    expect(stubResult("native_window_list")).toBeNull();
  });

  it("does not stub fs reads (they belong to the gateway)", () => {
    // fs_watch/fs_unwatch stub (desktop watchers), but fs reads forward.
    expect(routeFor("fs_read_file")).toBe("gateway");
    expect(routeFor("fs_list_dir")).toBe("gateway");
    expect(routeFor("fs_watch_dirs")).toBe("stub");
  });
});
