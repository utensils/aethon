/**
 * Builders for the `aethon.tasks` + `aethon.dashboard` sub-APIs.
 *
 * Extracted from `aethon-api.ts` so the `buildAethonApi` factory stays a
 * thin composition root. Both surfaces round through the same
 * `dashboard_query` bridge message (the mutation-ack channel), so they
 * share one private query helper and live together. They give the model
 * UI parity with the per-project dashboard composer and repo overview.
 */

import type { AethonAgentState, MutationResult } from "./state";
import type { DashboardApi, TasksApi } from "./aethon-api";
import { trackMutation } from "./mutation-ack";

export interface DashboardApiDeps {
  send: (obj: Record<string, unknown>) => void;
}

const MUTATION_ACK_TIMEOUT_MS_DEFAULT = 5_000;

/** Shared `dashboard_query` round-trip for both the tasks and dashboard
 *  surfaces. Blocks on the frontend handshake (bounded) before sending so
 *  pre-ready callers get a clean `frontend_not_ready` rather than a hang. */
async function dashboardQuery(
  state: AethonAgentState,
  deps: DashboardApiDeps,
  op:
    | "start_task"
    | "get_repo_overview"
    | "refresh"
    | "list_issues"
    | "get_issue",
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<MutationResult> {
  if (!state.frontendReady) {
    const ready = await Promise.race<boolean>([
      state.frontendReadyPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), MUTATION_ACK_TIMEOUT_MS_DEFAULT),
      ),
    ]);
    if (!ready) return { ok: false, error: "frontend_not_ready" };
  }
  const { id, promise } = trackMutation(state, timeoutMs);
  deps.send({ type: "dashboard_query", mutationId: id, op, args });
  return promise;
}

export function buildTasksApi(
  state: AethonAgentState,
  deps: DashboardApiDeps,
): TasksApi {
  return {
    start: (input) => {
      if (
        !input ||
        typeof input.projectPath !== "string" ||
        !input.projectPath
      ) {
        return Promise.resolve({ ok: false, error: "projectPath required" });
      }
      if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        return Promise.resolve({ ok: false, error: "prompt required" });
      }
      return dashboardQuery(
        state,
        deps,
        "start_task",
        {
          projectPath: input.projectPath,
          prompt: input.prompt,
          ...(typeof input.newWorktree === "boolean"
            ? { newWorktree: input.newWorktree }
            : {}),
          ...(typeof input.branch === "string" ? { branch: input.branch } : {}),
          ...(typeof input.baseBranch === "string"
            ? { baseBranch: input.baseBranch }
            : {}),
          ...(typeof input.model === "string" && input.model
            ? { model: input.model }
            : {}),
          ...(typeof input.bridgePrompt === "string" && input.bridgePrompt
            ? { bridgePrompt: input.bridgePrompt }
            : {}),
        },
        // Worktree-create + tab-open + send can take several seconds on a
        // large repo. 30s is the same ceiling as the shell-write ack
        // pattern, which is the closest existing precedent.
        30_000,
      );
    },
  };
}

export function buildDashboardApi(
  state: AethonAgentState,
  deps: DashboardApiDeps,
): DashboardApi {
  return {
    getRepoOverview: (input) => {
      if (
        !input ||
        typeof input.projectPath !== "string" ||
        !input.projectPath
      ) {
        return Promise.resolve({ ok: false, error: "projectPath required" });
      }
      return dashboardQuery(state, deps, "get_repo_overview", {
        projectPath: input.projectPath,
      });
    },
    refresh: (input) =>
      dashboardQuery(state, deps, "refresh", {
        ...(input && typeof input.projectPath === "string"
          ? { projectPath: input.projectPath }
          : {}),
      }),
    listIssues: (input) => {
      if (
        !input ||
        typeof input.projectPath !== "string" ||
        !input.projectPath
      ) {
        return Promise.resolve({ ok: false, error: "projectPath required" });
      }
      return dashboardQuery(state, deps, "list_issues", {
        projectPath: input.projectPath,
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      });
    },
    getIssue: (input) => {
      if (
        !input ||
        typeof input.projectPath !== "string" ||
        !input.projectPath ||
        typeof input.number !== "number" ||
        input.number <= 0
      ) {
        return Promise.resolve({
          ok: false,
          error: "projectPath + positive integer number required",
        });
      }
      return dashboardQuery(state, deps, "get_issue", {
        projectPath: input.projectPath,
        number: input.number,
      });
    },
  };
}
