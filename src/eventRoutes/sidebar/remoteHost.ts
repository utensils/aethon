import type { EventRouteHandler } from "../types";

function hostIdFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** sidebar rename-remote-host: persist a paired desktop host alias. The
 *  host hook refreshes the list from `remote-hosts-changed`; this handler
 *  only owns command dispatch + feedback. */
export const handleSidebarRenameRemoteHost: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-remote-host") return false;
  const selected = data as
    | {
        hostId?: string;
        itemId?: string;
        label?: string;
        previousLabel?: string;
      }
    | undefined;
  const id = hostIdFrom(selected?.hostId ?? selected?.itemId);
  const label = selected?.label?.trim() ?? "";
  if (!id || !label) return true;
  const previousLabel = selected?.previousLabel ?? id;

  ctx
    .invoke("remote_host_rename", { id, name: label })
    .then(() => {
      ctx.pushNotification({
        title: "Host renamed",
        message: label,
        kind: "success",
      });
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Rename host failed",
        message: `${previousLabel}: ${String(err)}`,
        kind: "error",
      });
    });
  return true;
};

/** sidebar reconnect-remote-host: re-probe a paired desktop host using its
 *  stored candidates/token. */
export const handleSidebarReconnectRemoteHost: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "reconnect-remote-host") return false;
  const selected = data as
    | { hostId?: string; itemId?: string; label?: string }
    | undefined;
  const id = hostIdFrom(selected?.hostId ?? selected?.itemId);
  if (!id) return true;
  const label = selected?.label ?? id;

  ctx
    .invoke("remote_host_reconnect", { id })
    .then(() => {
      ctx.pushNotification({
        title: `Reconnect requested for ${label}`,
        kind: "success",
        durationMs: 3000,
      });
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: `Reconnect ${label} failed`,
        message: String(err),
        kind: "error",
        durationMs: 8000,
      });
    });
  return true;
};

/** sidebar forget-remote-host: remove an outbound paired-host token and
 *  leave the local host selected if the forgotten host was active. */
export const handleSidebarForgetRemoteHost: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "forget-remote-host") return false;
  const selected = data as
    | { hostId?: string; itemId?: string; label?: string }
    | undefined;
  const id = hostIdFrom(selected?.hostId ?? selected?.itemId);
  if (!id) return true;
  const label = selected?.label ?? id;

  ctx
    .invoke("remote_host_forget", { id })
    .then(() => {
      if (ctx.stateRef.current.activeHostId === id) {
        ctx.setActiveHost(null);
      }
      ctx.pushNotification({
        title: "Host forgotten",
        message: label,
        kind: "success",
      });
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: `Forget ${label} failed`,
        message: String(err),
        kind: "error",
        durationMs: 8000,
      });
    });
  return true;
};
