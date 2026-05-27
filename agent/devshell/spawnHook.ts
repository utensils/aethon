/**
 * Synchronous {@link BashSpawnHook} that layers the project's Nix
 * devshell env over whatever pi's bash tool would otherwise inherit.
 *
 * The hook reads the agent's local cache (populated by
 * {@link ensureFetched} on session creation and refreshed on
 * `devshell-ready` events forwarded from the frontend). On a cold
 * cache it emits a single advisory warning into the agent-bash stream
 * and fires the fetch in the background so the next tool call sees
 * the devshell env.
 */

import type { BashSpawnContext, BashSpawnHook } from "@mariozechner/pi-coding-agent";
import type { AethonAgentState } from "../state";
import { getCachedEnv, maybeWarnColdRun, type DevshellClientDeps } from "./client";

export function buildDevshellSpawnHook(
  state: AethonAgentState,
  deps: DevshellClientDeps,
): BashSpawnHook {
  return (ctx: BashSpawnContext): BashSpawnContext => {
    const { env, kind, hot } = getCachedEnv(state, deps, ctx.cwd);
    if (!hot) {
      // First-shot for this cwd — warn once, then return ctx unchanged.
      // The kick has already been fired by getCachedEnv.
      maybeWarnColdRun(ctx.cwd, kind);
      return ctx;
    }
    if (!env || Object.keys(env).length === 0) {
      // Cache says "no devshell here" — pass through.
      return ctx;
    }
    // Merge devshell env over the host env. Devshell PATH must win
    // so commands like `cargo` and `bun` resolve from the
    // /nix/store... bins rather than rustup/nvm.
    const mergedEnv: NodeJS.ProcessEnv = {
      ...ctx.env,
      ...env,
    };
    return {
      ...ctx,
      env: mergedEnv,
    };
  };
}
