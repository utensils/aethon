import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

/** Bridge proxy for the agent's working-directory git lookups.
 *
 *  The agent injects a per-turn "Working context" block into the model's
 *  system prompt (so a local model doesn't lose track of the active tab's
 *  cwd). It can't call Tauri directly, so it rounds a `git_query` message
 *  through here; we invoke the Rust `git_working_context` command (which
 *  resolves `git` via the PATH-augmenting `env` helper, so it works in
 *  Finder-launched release builds) and ack the result.
 *
 *  Currently one op:
 *    - `working_context` — `{ repoRoot, branch, isWorktree, changedFiles,
 *      ahead, behind } | null` for a cwd (null when not a git work tree).
 */
export const handleGitQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op === "working_context") {
      const cwd = args.cwd as string | undefined;
      if (!cwd) throw new Error("git_query.working_context requires cwd");
      return await invoke("git_working_context", { cwd });
    }
    throw new Error(`unknown git_query op: ${op}`);
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
