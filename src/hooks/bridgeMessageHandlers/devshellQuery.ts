import { invokeForHost } from "../../remoteInvoke";
import type { BridgeMessageHandler } from "./types";

/** Bridge proxy for the agent's `aethon.devshell.*` queries
 *  (currently consumed by the bash spawnHook).
 *
 *  Four ops, mirroring the Rust IPC surface:
 *    - `status` — non-blocking snapshot for the status badge / agent
 *      hot-cache primer.
 *    - `prepare_for_path` — blocking project/workspace preparation used before
 *      provisioning an agent session.
 *    - `env_for_path` — non-blocking env lookup. The spawnHook
 *      consumes this; when state is still `Resolving` the response
 *      carries an empty `env` and the agent re-fetches after the
 *      `devshell-ready` push event lands.
 *    - `refresh` — invalidate cache + kick off a re-resolve. The
 *      Settings "Refresh now" button (when called from an extension)
 *      reaches here.
 *
 *  All three ack via `ctx.ackMutation` so the bridge's `trackMutation`
 *  resolves the spawnHook fetcher's Promise.
 */
export const handleDevshellQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op === "status") {
      const root = args.root as string | undefined;
      if (!root) throw new Error("devshell_query.status requires root");
      return await invokeForHost(ctx.sourceHostId, "devshell_status", {
        args: { root },
      });
    }
    if (op === "env_for_path") {
      const cwd = args.cwd as string | undefined;
      if (!cwd) throw new Error("devshell_query.env_for_path requires cwd");
      return await invokeForHost(ctx.sourceHostId, "devshell_env_for_path", {
        args: { cwd },
      });
    }
    if (op === "prepare_for_path") {
      const cwd = args.cwd as string | undefined;
      if (!cwd) throw new Error("devshell_query.prepare_for_path requires cwd");
      const includeEnv = args.includeEnv === true;
      return await invokeForHost(ctx.sourceHostId, "devshell_prepare_for_path", {
        args: { cwd, includeEnv },
      });
    }
    if (op === "refresh") {
      const root = args.root as string | undefined;
      if (!root) throw new Error("devshell_query.refresh requires root");
      return await invokeForHost(ctx.sourceHostId, "devshell_refresh", {
        args: { root },
      });
    }
    throw new Error(`unknown devshell_query op: ${op}`);
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
