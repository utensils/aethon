import type { EventRouteHandler } from "../types";
import type { Tab } from "../../types/tab";
import { extractSessionId } from "../../utils/sidebarHistory";
import { renameSessionLabel } from "../sessionRename";

/** sidebar delete-session: prompt user, then delete via the Tauri
 *  command. Delete-then-close ordering matters — if deletion fails,
 *  the open tab should stay visible. */
export const handleSidebarDeleteSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "delete-session") return false;
  const selected = data as
    | {
        sessionId?: string;
        itemId?: string;
        label?: string;
        confirmed?: boolean;
      }
    | undefined;
  // Strip the "session:" or "tab:" prefix defensively in case a future
  // caller forgets the split — the sidebar already strips it but we
  // don't want a stray prefix to land in the Tauri command path
  // validator.
  const raw = selected?.sessionId ?? selected?.itemId ?? "";
  const sessionId = extractSessionId(raw);
  const label = selected?.label ?? sessionId;
  if (!sessionId) return true;
  const deleteAfterConfirmation = (allowed: boolean) => {
    if (!allowed) return;
    const isOpen = (ctx.stateRef.current.tabs as Tab[] | undefined)?.some(
      (t) => t.id === sessionId,
    );
    ctx
      .invoke("delete_session", { tabId: sessionId })
      .then(() => {
        if (isOpen) ctx.closeTab(sessionId);
        ctx.allDiscoveredSessionsRef.current =
          ctx.allDiscoveredSessionsRef.current.filter(
            (s) => s.tabId !== sessionId,
          );
        ctx.syncRecentSessionsToState();
        ctx.pushNotification({
          title: "Session deleted",
          message: label,
          kind: "success",
        });
      })
      .catch((err: unknown) => {
        ctx.pushNotification({
          title: "Delete session failed",
          message: String(err),
          kind: "error",
        });
      });
  };
  if (selected?.confirmed === true) {
    deleteAfterConfirmation(true);
  } else {
    ctx.promptDeleteSessionConfirmation(label).then(deleteAfterConfirmation);
  }
  return true;
};

/** sidebar rename-session: forward the new label to the bridge AND
 *  optimistically update the open tab's label if the target is
 *  currently open. The bridge persists
 *  `<sessionsDir>/<tabId>/label.txt` and re-emits `ready`; the
 *  optimistic update is what makes the change visible immediately for
 *  open-tab rows (whose `tab:` label flows from `Tab.label`, not from
 *  `recentSessions`/`discoveredTabs`). */
export const handleSidebarRenameSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-session") return false;
  const selected = data as
    | { sessionId?: string; itemId?: string; label?: string }
    | undefined;
  const raw = selected?.sessionId ?? selected?.itemId ?? "";
  const sessionId = extractSessionId(raw);
  const label = typeof selected?.label === "string" ? selected.label : "";
  if (!sessionId) return true;
  renameSessionLabel(ctx, sessionId, label);
  return true;
};
