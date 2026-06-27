/**
 * Session branching — rollback and fork.
 *
 * Both are thin wrappers over pi's `SessionManager`:
 *  - rollback: `branch(entryId)` rewinds the active session's leaf to an
 *    earlier message. Non-destructive — the abandoned path stays in the file,
 *    so a later restore still sees it; we just realign the Aethon-local chat
 *    so it doesn't resurrect post-rollback rows.
 *  - fork: `createBranchedSession(entryId)` extracts the path root→entry into a
 *    fresh jsonl (in the source tab's dir) *without* disturbing the source
 *    session. The frontend then moves that file into a new tab's dir (via the
 *    `copy_session_file` Rust command) and opens the tab.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { AethonAgentState, TabRecord } from "./state";
import type { DispatcherDeps, InboundMessage } from "./dispatcherTypes";
import { ensureTab, tabSessionDir } from "./tab-lifecycle";
import {
  readSessionLabel,
  truncateLocalChatAfterEntry,
  writeSessionLabel,
} from "./session-history";

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSessionBusy(tab: TabRecord): boolean {
  const flags = tab.session as { isStreaming?: unknown; isRetrying?: unknown };
  return (
    tab.promptInFlight ||
    tab.aethonRetryInFlight === true ||
    flags.isStreaming === true ||
    flags.isRetrying === true
  );
}

function parseEntryTimestamp(entry: {
  timestamp?: unknown;
}): number | undefined {
  const ts = entry.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mirroredTabCwd(
  state: AethonAgentState,
  tabId: string,
): string | undefined {
  const tabs = state.frontendState.get("/tabs");
  if (!Array.isArray(tabs)) return undefined;
  for (const item of tabs) {
    if (!item || typeof item !== "object") continue;
    const tab = item as { id?: unknown; kind?: unknown; cwd?: unknown };
    if (tab.id !== tabId) continue;
    if (tab.kind && tab.kind !== "agent") return undefined;
    return typeof tab.cwd === "string" && tab.cwd.length > 0
      ? tab.cwd
      : undefined;
  }
  return undefined;
}

async function ensureBranchTab(
  state: AethonAgentState,
  deps: DispatcherDeps,
  tabId: string,
  cwdHint?: string,
): Promise<TabRecord | undefined> {
  const existing = state.tabs.get(tabId);
  if (existing) return existing;
  const cwd =
    state.tabProjectCwds.get(tabId) ?? mirroredTabCwd(state, tabId) ?? cwdHint;
  if (!cwd) return undefined;
  return ensureTab(state, deps, tabId, { cwdOverride: cwd });
}

export async function handleRollbackSession(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = stringField(msg.tabId);
  const entryId = stringField(msg.entryId);
  if (!tabId || !entryId) {
    deps.send({
      type: "error",
      message: "rollback_session: tabId and entryId required",
    });
    return;
  }
  const cwdHint = stringField(msg.cwd);
  const tab = await ensureBranchTab(state, deps, tabId, cwdHint);
  if (!tab) {
    deps.send({
      type: "error",
      tabId,
      message: "rollback_session: unknown tab",
    });
    return;
  }
  const sm = tab.session.sessionManager;
  const entry = sm.getEntry(entryId);
  if (!entry) {
    deps.send({
      type: "error",
      tabId,
      message: `rollback_session: unknown entry ${entryId}`,
    });
    return;
  }
  // Abort any in-flight turn before mutating the branch.
  if (isSessionBusy(tab)) {
    try {
      await tab.session.abort();
    } catch {
      /* best effort — we're rewinding anyway */
    }
    tab.promptInFlight = false;
    tab.agentEndFired = true;
    tab.queuedCount = 0;
    if (state.currentAgentTabId === tabId) state.currentAgentTabId = undefined;
  }
  try {
    sm.branch(entryId);
  } catch (err) {
    deps.send({
      type: "error",
      tabId,
      message: `rollback_session: ${(err as Error).message}`,
    });
    return;
  }
  const cutoff = parseEntryTimestamp(entry);
  if (cutoff !== undefined) {
    await truncateLocalChatAfterEntry(
      tabSessionDir(state, tabId),
      cutoff,
    ).catch(() => {
      /* best effort */
    });
  }
  deps.send({ type: "session_rolled_back", tabId, entryId });
}

function forkLabel(srcLabel: string | undefined): string {
  const base = srcLabel?.trim() ? srcLabel.trim() : "session";
  return `Fork of ${base}`.slice(0, 120);
}

export async function handleForkSession(
  state: AethonAgentState,
  deps: DispatcherDeps,
  msg: InboundMessage,
): Promise<void> {
  const tabId = stringField(msg.tabId);
  const entryId = stringField(msg.entryId);
  if (!tabId || !entryId) {
    deps.send({
      type: "error",
      message: "fork_session: tabId and entryId required",
    });
    return;
  }
  const cwdHint = stringField(msg.cwd);
  const tab = await ensureBranchTab(state, deps, tabId, cwdHint);
  if (!tab) {
    deps.send({ type: "error", tabId, message: "fork_session: unknown tab" });
    return;
  }
  const sm = tab.session.sessionManager;
  if (!sm.getEntry(entryId)) {
    deps.send({
      type: "error",
      tabId,
      message: `fork_session: unknown entry ${entryId}`,
    });
    return;
  }
  let sourcePath: string | undefined;
  try {
    sourcePath = sm.createBranchedSession(entryId);
  } catch (err) {
    deps.send({
      type: "error",
      tabId,
      message: `fork_session: ${(err as Error).message}`,
    });
    return;
  }
  if (!sourcePath) {
    deps.send({
      type: "error",
      tabId,
      message: "fork_session: cannot fork an in-memory session",
    });
    return;
  }
  const newTabId = randomUUID();
  const newDir = tabSessionDir(state, newTabId);
  try {
    mkdirSync(newDir, { recursive: true });
  } catch {
    /* the Rust copy command also creates it */
  }
  const srcLabel = await readSessionLabel(tabSessionDir(state, tabId)).catch(
    () => undefined,
  );
  const label = forkLabel(srcLabel);
  const cwd =
    state.tabProjectCwds.get(tabId) ?? mirroredTabCwd(state, tabId) ?? cwdHint;
  await writeSessionLabel(newDir, label, {
    ...(cwd ? { cwd } : {}),
  }).catch(() => {
    /* best effort */
  });
  deps.send({
    type: "session_forked",
    tabId,
    newTabId,
    sourcePath,
    label,
    ...(cwd ? { cwd } : {}),
  });
}
