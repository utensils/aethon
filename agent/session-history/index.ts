/**
 * Session-history public surface. The 8-function API previously lived
 * in `session-history.ts`; submodules under this directory carry the
 * per-layer implementations:
 *
 *  - shared.ts     — types + constants + pure helpers (textFromContent,
 *                    thinkingFromContent, isChatRole, hasA2ui, trimText,
 *                    normalizeCwd)
 *  - parse-pi.ts   — parseSessionHistoryLines (Anthropic JSONL transcript)
 *  - parse-local.ts — parseLocalChatLines + readLocalChatTranscript
 *                    (aethon-chat.jsonl append-log)
 *  - io.ts         — normalizeSessionLabel, readSessionLabel,
 *                    writeSessionLabel, appendLocalChatMessage
 *                    (atomic-prune append + label read/write)
 *  - metadata.ts   — latestSessionLog, readSessionMetadata (sidebar
 *                    row labels)
 *  - lookup.ts     — findSessionFileMatchingCwd (project-safety bridge
 *                    for ensureTab on the shared `default` dir)
 *  - restore.ts    — readSessionTranscript (orchestration + dedupe)
 *
 * External callers keep importing from `"./session-history"`; this
 * barrel resolves their imports to the directory's index.
 */

export type {
  RestoredChatAttachment,
  RestoredChatMessage,
  SessionLogMetadata,
} from "./shared";
export { hasA2ui, parseChatAttachments } from "./shared";
export { parseSessionHistoryLines } from "./parse-pi";
export {
  appendLocalChatMessage,
  normalizeSessionLabel,
  readSessionLabel,
  truncateLocalChatAfterEntry,
  writeSessionLabel,
} from "./io";
export { latestSessionLog, readSessionMetadata } from "./metadata";
export { findSessionFileMatchingCwd } from "./lookup";
export { readSessionTranscript } from "./restore";
export {
  appendSyntheticSubagentToolResults,
  findDanglingSubagentToolCalls,
  isSubagentToolName,
  repairDanglingSubagentToolResults,
  syntheticSubagentCancellationText,
  syntheticSubagentToolResultMessage,
} from "./subagent-tool-results";
export type {
  DanglingSubagentToolCall,
  SyntheticSubagentToolResult,
} from "./subagent-tool-results";
