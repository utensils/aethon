import type { EventRouteHandler } from "./types";

/** Reserved shell-consent action prefixes on `notification-stack`.
 *  Listed so the contract test and any new audit can assert against the
 *  canonical set. Adding to this list means adding a `resolveX` /
 *  `hasPendingX` pair on EventRouteContext and a branch below. */
export const SHELL_CONSENT_PREFIXES = Object.freeze([
  "shell-write-",
  "shell-close-",
  "session-delete-",
] as const);

/** Top-precedence route. Runs before extension interception so a user's
 *  Allow / Deny / dismiss on a shell-consent prompt can never be
 *  hijacked by an extension that registered for `notification-stack`.
 *  Filters narrowly on the three reserved action prefixes plus
 *  dismiss/expire of an id with a pending resolver — every other
 *  notification-stack event falls through. */
export const handleShellConsent: EventRouteHandler = ({
  component,
  eventType,
  data,
}, ctx) => {
  if (component.id !== "notification-stack") return false;
  const id = (data as { id?: string } | undefined)?.id;
  const action = (data as { action?: string } | undefined)?.action;

  // shell-write
  if (
    eventType === "action" &&
    typeof action === "string" &&
    action.startsWith("shell-write-") &&
    id
  ) {
    const allowed = action.startsWith("shell-write-allow:");
    ctx.resolveShellWriteConsent(id, allowed);
    ctx.dismissNotification(id);
    return true;
  }
  if (
    (eventType === "dismiss" || eventType === "expire") &&
    typeof id === "string" &&
    ctx.hasPendingShellWriteConsent(id)
  ) {
    ctx.resolveShellWriteConsent(id, false);
    ctx.dismissNotification(id);
    return true;
  }

  // shell-close
  if (
    eventType === "action" &&
    typeof action === "string" &&
    action.startsWith("shell-close-") &&
    id
  ) {
    const allowed = action.startsWith("shell-close-allow:");
    ctx.resolveShellCloseConsent(id, allowed);
    ctx.dismissNotification(id);
    return true;
  }
  if (
    (eventType === "dismiss" || eventType === "expire") &&
    typeof id === "string" &&
    ctx.hasPendingShellCloseConsent(id)
  ) {
    ctx.resolveShellCloseConsent(id, false);
    ctx.dismissNotification(id);
    return true;
  }

  // session-delete
  if (
    eventType === "action" &&
    typeof action === "string" &&
    action.startsWith("session-delete-") &&
    id
  ) {
    const allowed = action.startsWith("session-delete-allow:");
    ctx.resolveSessionDeleteConsent(id, allowed);
    ctx.dismissNotification(id);
    return true;
  }
  if (
    (eventType === "dismiss" || eventType === "expire") &&
    typeof id === "string" &&
    ctx.hasPendingSessionDeleteConsent(id)
  ) {
    ctx.resolveSessionDeleteConsent(id, false);
    ctx.dismissNotification(id);
    return true;
  }

  return false;
};
