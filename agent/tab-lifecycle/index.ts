/**
 * Multi-tab session lifecycle. Barrel re-export — replaces the old
 * tab-lifecycle.ts module. Consumers keep importing from
 * `"./tab-lifecycle"`; this `index.ts` resolves their imports to the
 * per-concern submodules below.
 *
 * Submodules:
 *  - utils.ts          — modelKey / modelDescriptor / compilePattern /
 *                        tabSessionDir + TabLifecycleDeps interface
 *  - terminal.ts       — emitBashResult (terminal panel chunked emit)
 *  - tools.ts          — cancelRunningToolCards (reload-sentinel
 *                        synthetic-end behavior)
 *  - models.ts         — buildPickerModels / defaultModelKey /
 *                        ensurePickerHasModel
 *  - slash-commands.ts — collectPiSlashCommands / refreshPiSlashCommands
 *  - ready-handshake.ts — emitReady (startup payload)
 *  - events.ts         — handleSessionEvent routing/orchestration
 *  - response-stream.ts — assistant text/thinking stream identity + backfill
 *  - tool-events.ts    — tool-card lifecycle + terminal mirroring
 *  - agent-end.ts      — agent_end routing across finalization/recovery paths
 *  - turn-finalization.ts — response_end, entry-id backfill, scheduled runs
 *  - retry-recovery.ts — SDK auto-retry events + usage-limit retry exhaustion
 *  - context-recovery.ts — context overflow compaction/resume flow
 *  - retry.ts          — Aethon-specific transient provider retry classifier
 *  - lifecycle.ts      — ensureTab + EnsureTabOptions
 */

export {
  extractToolContent,
  inferToolResultLanguage,
  summarizeToolArgs,
  toolCardPayload,
} from "../tool-card";

export type { TabLifecycleDeps } from "./utils";
export {
  compilePattern,
  modelDescriptor,
  modelKey,
  tabSessionDir,
} from "./utils";
export { emitBashResult } from "./terminal";
export {
  cancelRunningToolCards,
  synthesizeCancelledSubagentToolResults,
} from "./tools";
export {
  buildPickerModels,
  defaultModelKey,
  ensurePickerHasModel,
  refreshCachedModels,
} from "./models";
export {
  collectPiSlashCommands,
  refreshPiSlashCommands,
} from "./slash-commands";
export { emitReady } from "./ready-handshake";
export { handleSessionEvent } from "./events";
export { cancelAethonRetry, installAethonRetryClassifier } from "./retry";
export type { EnsureTabOptions } from "./lifecycle";
export { ensureTab, resolveTabCwd } from "./lifecycle";
export {
  contextUsageSnapshot,
  emitContextUsage,
  type ContextUsageSnapshot,
} from "../context-usage";
