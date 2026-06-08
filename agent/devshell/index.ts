/**
 * Devshell support on the agent side. The cache + spawnHook live here
 * so `agent/tab-lifecycle/lifecycle.ts` can wire a single import.
 */

export { buildDevshellSpawnHook } from "./spawnHook";
export {
  ensurePrepared,
  ensureFetched,
  getCachedEnv,
  maybeWarnColdRun,
  onDevshellEvent,
  refresh,
  seedPreparedEnv,
  _resetForTests,
} from "./client";
export type { DevshellClientDeps } from "./client";
