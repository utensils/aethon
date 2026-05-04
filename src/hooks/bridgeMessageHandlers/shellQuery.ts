import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

/** Bridge proxy for `aethon.shells.{list, read, write}`. Mode changes go
 *  through the status-bar badge (frontend invokes `shell_set_share_mode`
 *  directly), never through the agent surface; otherwise an extension
 *  could flip a private tab into sharing without a user gesture and
 *  bypass the opt-in boundary.
 *
 *  For write: we check share mode here (read-write → overlay confirm;
 *  read-write-trusted → write directly; private/read → refuse), then
 *  invoke the Rust shell_write which gates again as defense-in-depth. */
export const handleShellQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;
  const route = async (): Promise<unknown> => {
    if (op === "list") {
      return await invoke("shell_list_shareable");
    }
    if (op === "read") {
      return await invoke("shell_read_scrollback", { args });
    }
    if (op === "write") {
      return await ctx.routeShellWrite(args);
    }
    throw new Error(`unknown shell_query op: ${op}`);
  };
  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
