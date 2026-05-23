import type { BridgeMessageHandler } from "./types";
import {
  getRepoOverview,
  refreshRepoOverview,
} from "../../ghRepoOverviewCache";

/** Bridge proxy for `aethon.tasks.start` + `aethon.dashboard.{getRepoOverview, refresh}`.
 *
 *  Three ops:
 *    - `start_task` — call the App-level `startTaskInProject` to spawn a
 *      worktree (if requested) + new tab + send first message. The
 *      caller passes `projectPath`; we resolve to a projectId from the
 *      live projects list.
 *    - `get_repo_overview` — return cached gh data for a project. Pure
 *      query; never triggers a worktree-create or tab spawn.
 *    - `refresh` — bust the gh cache for one project (or all if no
 *      path given) so the next read shells out fresh.
 *
 *  All three ack via `ctx.ackMutation` so the bridge's `trackMutation`
 *  resolves the pi tool's Promise.
 */
export const handleDashboardQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = (data.args as Record<string, unknown> | undefined) ?? {};
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op === "start_task") {
      const projectPath = args.projectPath as string | undefined;
      const prompt = args.prompt as string | undefined;
      if (!projectPath || !prompt) {
        throw new Error("start_task requires projectPath + prompt");
      }
      const project = ctx.projectsRef.current.projects.find(
        (p) => p.path === projectPath,
      );
      if (!project) {
        throw new Error(`unknown project path: ${projectPath}`);
      }
      await ctx.startTaskInProject({
        projectId: project.id,
        prompt,
        newWorktree: args.newWorktree === true,
        branch: args.branch as string | undefined,
        baseBranch: args.baseBranch as string | undefined,
      });
      return { ok: true, projectId: project.id };
    }

    if (op === "get_repo_overview") {
      const projectPath = args.projectPath as string | undefined;
      if (!projectPath) {
        throw new Error("get_repo_overview requires projectPath");
      }
      const overview = await getRepoOverview(projectPath);
      return overview;
    }

    if (op === "refresh") {
      const projectPath = args.projectPath as string | undefined;
      if (projectPath) {
        await refreshRepoOverview(projectPath);
      }
      return { ok: true };
    }

    throw new Error(`unknown dashboard_query op: ${op}`);
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
