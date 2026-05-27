/**
 * Devshell support on the agent side. The cache + spawnHook live here
 * so `agent/tab-lifecycle/lifecycle.ts` can wire a single import.
 */

export { buildDevshellSpawnHook } from "./spawnHook";
export {
  ensureFetched,
  getCachedEnv,
  maybeWarnColdRun,
  onDevshellEvent,
  refresh,
  _resetForTests,
} from "./client";
export type { DevshellClientDeps } from "./client";
