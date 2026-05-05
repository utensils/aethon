import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

/** Bridge asks the supervisor to restart it. Used after a state change
 *  the bridge can't apply hot — e.g. user toggled an extension via the
 *  sidebar context menu. We invoke `force_restart_agent`, which sets
 *  the supervisor's `agent_reload_in_progress` flag so the next agent
 *  command respawns the bridge cleanly (emits `agent-reloaded`, not
 *  `agent-crashed`). The new bridge reads disabled-extensions.json on
 *  boot and the loader honors the user's intent.
 */
export const handleReloadRequired: BridgeMessageHandler = (data, _ctx) => {
  const reason = (data.reason as string | undefined) ?? "unspecified";
  // `reload_agent` sets the supervisor's agent_reload_in_progress flag
  // before killing the child, so EOF is treated as a clean reload
  // (emits `agent-reloaded`, not `agent-crashed`). The existing
  // `agent-reloaded` listener (useOsEdges) re-primes via start_agent,
  // so we don't need to chain an explicit spawn here.
  invoke("reload_agent").catch((err: unknown) => {
    // Best-effort. If the restart fails the toggle still applies on
    // the next manual restart; we just won't get an instant reload.
    // eslint-disable-next-line no-console
    console.warn(`reload_required (${reason}): reload_agent failed`, err);
  });
};
