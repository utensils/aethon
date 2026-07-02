import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

/** The global bridge applied an extension toggle in process (no
 *  restart), but per-tab workers loaded their extensions at spawn —
 *  ask the shell to send each `tab:*` worker a `reload_request` so it
 *  drains in-flight prompts and lazily respawns with the fresh
 *  disabled list. The global bridge is untouched. */
export const handleWorkerRefreshRequired: BridgeMessageHandler = (
  data,
  _ctx,
) => {
  const reason = (data.reason as string | undefined) ?? "unspecified";
  invoke("request_worker_reloads").catch((err: unknown) => {
    // Best-effort: a worker that misses the refresh still picks up the
    // toggle on its next natural respawn (idle retire, cwd change).
    console.warn(
      `worker_refresh_required (${reason}): request_worker_reloads failed`,
      err,
    );
  });
};
