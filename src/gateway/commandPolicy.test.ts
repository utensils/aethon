import { describe, expect, it } from "vitest";

import { routeFor, stubResult } from "./commandPolicy";

describe("mobile command policy", () => {
  it("routes native plugin commands locally", () => {
    expect(routeFor("plugin:notification|notify")).toBe("local");
    expect(routeFor("plugin:opener|open_url")).toBe("local");
  });

  it("stubs desktop-only command families", () => {
    for (const cmd of [
      "voice_start_recording",
      "native_window_open_canvas",
      "devshell_status",
      "shell_open",
      "git_status",
      "gh_repo_overview",
      "fs_watch_dirs",
      "updater_available",
      "write_state",
      "toggle_devtools",
      "server_status",
      "remote_pairing_begin",
      "control_update_state",
    ]) {
      expect(routeFor(cmd)).toBe("stub");
    }
  });

  it("forwards the chat + read surface to the gateway", () => {
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
    ]) {
      expect(routeFor(cmd)).toBe("gateway");
    }
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
