import type { EventRouteHandler } from "./types";

/** General notification-stack handler. Runs AFTER `handleShellConsent`
 *  in the dispatch table — the consent gate has already short-circuited
 *  the three reserved action prefixes (shell-write-, shell-close-,
 *  session-delete-). Remaining shapes:
 *
 *  • dismiss/expire of any id — defensively resolves consents to
 *    `false` so a dropped notification can't dangle the originator's
 *    promise (idempotent: the ids without pending resolvers are no-ops).
 *  • action with reserved prefix arriving at the general handler (e.g.
 *    extension flipped routing late) — same defensive resolve.
 *  • ae-agent-crashed: action — restart the bridge.
 *  • hang-warn: action — stop / force-restart.
 *  • everything else with an action — forward to the bridge as a
 *    `notification.invoke` a2ui event for extension matchers. */
export const handleNotifications: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "notification-stack") return false;
  const id = (data as { id?: string } | undefined)?.id;

  if ((eventType === "dismiss" || eventType === "expire") && id) {
    // Safety net — resolve all three consent kinds to false; resolvers
    // for ids without a pending entry are no-ops.
    ctx.resolveShellWriteConsent(id, false);
    ctx.resolveShellCloseConsent(id, false);
    ctx.resolveSessionDeleteConsent(id, false);
    ctx.dismissNotification(id);
    return true;
  }

  if (eventType === "action" && id) {
    const action = (data as { action?: string } | undefined)?.action;
    if (action && action.startsWith("shell-write-")) {
      const allowed = action.startsWith("shell-write-allow:");
      ctx.resolveShellWriteConsent(id, allowed);
    } else if (action && action.startsWith("shell-close-")) {
      const allowed = action.startsWith("shell-close-allow:");
      ctx.resolveShellCloseConsent(id, allowed);
    } else if (action && action.startsWith("session-delete-")) {
      const allowed = action.startsWith("session-delete-allow:");
      ctx.resolveSessionDeleteConsent(id, allowed);
    } else if (
      action &&
      action.startsWith("ae-agent-crashed:")
    ) {
      if (action === "ae-agent-crashed:restart") {
        ctx.invoke("start_agent").catch((err: unknown) => {
          console.warn("agent restart failed:", err);
        });
      }
      ctx.dismissNotification(id);
      return true;
    } else if (action && action.startsWith("hang-warn:")) {
      if (action.startsWith("hang-warn:stop")) {
        // Stop carries the tabId of the hung tab so the right session
        // is stopped even if the user is on a different tab when they
        // click.
        const targetTabId = action.startsWith("hang-warn:stop:")
          ? action.slice("hang-warn:stop:".length)
          : undefined;
        void ctx.stopPrompt(targetTabId);
      } else if (action === "hang-warn:force-restart") {
        // force_restart_agent SIGKILLs the bun child from Rust,
        // bypassing blocked stdin. The agent-crashed handler clears
        // waiting state and (if auto_restart_agent) respawns.
        ctx.invoke("force_restart_agent").catch((err: unknown) => {
          console.warn("force_restart_agent failed:", err);
        });
      }
      ctx.dismissNotification(id);
      return true;
    } else if (action) {
      const tabId = ctx.stateRef.current.activeTabId as string | undefined;
      ctx
        .invoke("dispatch_a2ui_event", {
          event: JSON.stringify({
            componentId: `notification__tpl__${id}`,
            componentType: "notification",
            templateRootType: "notification",
            eventType: "invoke",
            data: { id, action },
          }),
          tabId,
        })
        .catch(() => {
          /* ignore — bridge gone */
        });
    }
    ctx.dismissNotification(id);
    return true;
  }

  return false;
};
