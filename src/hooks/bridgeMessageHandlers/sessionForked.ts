import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The bridge extracted a branch into a new session file (`sourcePath`) and
 * allocated `newTabId`. We move that file into the new tab's session dir via
 * the FS-safe `copy_session_file` command, then open the tab with its restored
 * history. The bridge can't invoke Tauri or open tabs, so this lands here.
 */
export const handleSessionForked: BridgeMessageHandler = (data, ctx) => {
  const newTabId = typeof data.newTabId === "string" ? data.newTabId : "";
  const sourcePath = typeof data.sourcePath === "string" ? data.sourcePath : "";
  const label = typeof data.label === "string" ? data.label : "Fork";
  const cwd = typeof data.cwd === "string" ? data.cwd : undefined;
  const sourceTabId = typeof data.tabId === "string" ? data.tabId : "";
  if (!newTabId || !sourcePath) return;

  void (async () => {
    try {
      await invoke("copy_session_file", { sourcePath, destTabId: newTabId });
    } catch (err) {
      // Don't open a tab pointing at a session file that never landed.
      if (sourceTabId) ctx.dismissNotification(`session-fork-${sourceTabId}`);
      ctx.pushNotification({
        title: "Fork failed",
        message: `Couldn't copy the forked session: ${errMessage(err)}`,
        kind: "error",
      });
      return;
    }
    ctx.newTab(newTabId, label, {
      restoredSession: true,
      ...(cwd ? { cwd } : {}),
    });
    if (sourceTabId) ctx.dismissNotification(`session-fork-${sourceTabId}`);
    ctx.pushNotification({
      title: "Forked session",
      message: `Opened ${label}.`,
      kind: "success",
      durationMs: 3000,
    });
  })();
};
