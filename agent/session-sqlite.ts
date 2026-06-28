/**
 * SQLite source of truth for Aethon sessions.
 *
 * Pi still receives a normal default-location session file as a sidecar. We
 * hydrate that sidecar from SQLite and wrap append/branch methods so Aethon
 * never needs to read pi JSONL files for restore/search/application state.
 */

import { createRequire } from "node:module";
import {
  existsSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
  type SessionTreeNode,
} from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import {
  MAX_CUSTOM_LABEL_CHARS,
  MAX_LABEL_CHARS,
  MAX_LOCAL_CHAT_MESSAGES,
  LOCAL_CHAT_FILE,
  type RestoredChatMessage,
  type SessionLogMetadata,
  hasA2ui,
  isChatRole,
  normalizeCwd,
  parseChatAttachments,
  textFromContent,
  thinkingFromContent,
  trimText,
} from "./session-history/shared";
import { parseLocalChatLines } from "./session-history/parse-local";

type DatabaseCtor = new (path: string) => Database;
interface Database {
  exec(sql: string): void;
  query(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

const require = createRequire(import.meta.url);
let databaseCtor: DatabaseCtor | undefined;
const cwdComparisonCache = new Map<string, string>();

function sqliteDatabaseCtor(): DatabaseCtor | undefined {
  if (databaseCtor) return databaseCtor;
  try {
    const mod = require("bun:sqlite") as { Database?: DatabaseCtor };
    databaseCtor = mod.Database;
    return databaseCtor;
  } catch {
    return undefined;
  }
}

function dbPath(): string | undefined {
  const path = process.env.AETHON_DB_FILE;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function openDb(): Database | undefined {
  const path = dbPath();
  const Ctor = sqliteDatabaseCtor();
  if (!path || !Ctor) return undefined;
  const db = new Ctor(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv_store (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (namespace, key)
    );
    CREATE TABLE IF NOT EXISTS session_tabs (
      tab_id TEXT PRIMARY KEY,
      cwd TEXT,
      custom_label TEXT,
      label_cwd TEXT,
      first_user_message TEXT,
      last_modified INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      cwd TEXT,
      current_leaf_entry_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE IF NOT EXISTS session_entries (
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_type TEXT NOT NULL,
      role TEXT,
      text TEXT,
      timestamp INTEGER,
      payload_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS session_local_messages (
      tab_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT,
      thinking TEXT,
      created_at INTEGER,
      cwd TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (tab_id, message_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
      tab_id UNINDEXED,
      role UNINDEXED,
      text,
      timestamp UNINDEXED,
      source UNINDEXED
    );
  `);
  return db;
}

function nowMs(): number {
  return Date.now();
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sessionText(entry: SessionEntry): string {
  if (entry.type === "message") return textFromContent(entry.message.content);
  if (entry.type === "custom_message") {
    return typeof entry.content === "string" ? entry.content : textFromContent(entry.content);
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.summary;
  }
  if (entry.type === "session_info") return entry.name ?? "";
  return "";
}

function sessionRole(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const role = entry.message.role;
  if (role === "assistant") return "agent";
  if (role === "user") return "user";
  if (role === "system") return "system";
  return typeof role === "string" ? role : undefined;
}

function rowString(row: Record<string, unknown> | null, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" ? value : undefined;
}

function rowNumber(row: Record<string, unknown> | null, key: string): number | undefined {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalCwd(cwd: string | undefined): string | undefined {
  const normalized = normalizeCwd(cwd);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function sessionMatchesCwd(sessionCwd: string | undefined, expectedCwd: string | undefined): boolean {
  const expected = canonicalCwdForComparison(expectedCwd);
  if (expected === undefined) return true;
  return canonicalCwdForComparison(sessionCwd) === expected;
}

function canonicalCwdForComparison(cwd: string | undefined): string | undefined {
  const normalized = normalizeOptionalCwd(cwd);
  if (!normalized) return undefined;
  const hit = cwdComparisonCache.get(normalized);
  if (hit !== undefined) return hit;
  let out = normalized;
  try {
    out = normalizeCwd(realpathSync(normalized)) ?? normalized;
  } catch {
    // Deleted workspaces still compare by their stored path.
  }
  cwdComparisonCache.set(normalized, out);
  return out;
}

function parseSessionLine(line: string): FileEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as FileEntry;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
  return Boolean(entry && entry.type === "session" && typeof entry.id === "string");
}

function isSessionEntry(entry: FileEntry | undefined): entry is SessionEntry {
  return Boolean(entry && entry.type !== "session" && typeof entry.id === "string");
}

function activeSessionEntries(entries: SessionEntry[], currentLeafEntryId?: string): SessionEntry[] {
  if (!currentLeafEntryId) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = byId.get(currentLeafEntryId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.length > 0 ? path : entries;
}

function loadSessionRows(db: Database, tabId: string, cwd: string): {
  header: SessionHeader;
  entries: SessionEntry[];
  currentLeafEntryId?: string;
} {
  db.query(
    `INSERT OR IGNORE INTO session_tabs(tab_id, cwd, metadata_json)
     VALUES (?, ?, '{}')`,
  ).run(tabId, cwd);
  let session = db
    .query(
      `SELECT session_id, current_leaf_entry_id, payload_json
       FROM sessions
       WHERE tab_id = ? AND (cwd = ? OR cwd IS NULL)
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(tabId, cwd);
  if (!session) {
    const timestamp = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd,
    };
    db.query(
      `INSERT INTO sessions(session_id, tab_id, cwd, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, tabId, cwd, JSON.stringify({ header }), nowMs(), nowMs());
    session = { session_id: sessionId, current_leaf_entry_id: null, payload_json: JSON.stringify({ header }) };
  }
  const currentLeafEntryId = rowString(session, "current_leaf_entry_id");
  const payload = rowString(session, "payload_json");
  const parsed = payload ? JSON.parse(payload) as { header?: SessionHeader } : {};
  const header = parsed.header ?? {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: rowString(session, "session_id") ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  const entries = db
    .query(
      `SELECT payload_json FROM session_entries
       WHERE session_id = ?
       ORDER BY ordinal ASC`,
    )
    .all(header.id)
    .flatMap((row) => {
      const raw = rowString(row, "payload_json");
      if (!raw) return [];
      try {
        return [JSON.parse(raw) as SessionEntry];
      } catch {
        return [];
      }
    });
  return {
    header,
    entries: activeSessionEntries(entries, currentLeafEntryId),
    ...(currentLeafEntryId ? { currentLeafEntryId } : {}),
  };
}

function persistEntryAtOrdinal(
  db: Database,
  tabId: string,
  sessionId: string,
  entry: SessionEntry,
  ordinal: number,
  options: { touch?: boolean; touchedAt?: number; index?: boolean } = {},
): void {
  const text = sessionText(entry);
  const role = sessionRole(entry);
  const timestamp = parseTime(entry.timestamp) ?? nowMs();
  db.query(
    `INSERT OR REPLACE INTO session_entries(
       session_id, entry_id, parent_entry_id, entry_type, role, text, timestamp, payload_json, ordinal
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    entry.id,
    entry.parentId,
    entry.type,
    role,
    text,
    timestamp,
    JSON.stringify(entry),
    ordinal,
  );
  if (options.touch !== false) {
    const touchedAt = options.touchedAt ?? nowMs();
    db.query(
      `UPDATE sessions
       SET current_leaf_entry_id = ?, updated_at = ?
       WHERE session_id = ?`,
    ).run(entry.id, touchedAt, sessionId);
    db.query("UPDATE session_tabs SET last_modified = ? WHERE tab_id = ?").run(touchedAt, tabId);
  }
  if (text && options.index !== false) {
    db.query(
      "INSERT INTO session_search_fts(tab_id, role, text, timestamp, source) VALUES (?, ?, ?, ?, 'pi')",
    ).run(tabId, role ?? "", text, timestamp);
  }
  if (entry.type === "message" && entry.message.role === "user") {
    const first = db
      .query("SELECT first_user_message FROM session_tabs WHERE tab_id = ?")
      .get(tabId);
    if (!rowString(first, "first_user_message") && text) {
      const label = text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}...` : text;
      db.query("UPDATE session_tabs SET first_user_message = ? WHERE tab_id = ?").run(label, tabId);
    }
  }
}

function persistEntry(db: Database, tabId: string, sessionId: string, entry: SessionEntry): void {
  const ordinalRow = db
    .query("SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM session_entries WHERE session_id = ?")
    .get(sessionId);
  persistEntryAtOrdinal(db, tabId, sessionId, entry, rowNumber(ordinalRow, "next") ?? 0);
}

function rebuildSidecar(manager: SessionManager, header: SessionHeader, entries: SessionEntry[]): void {
  const mutable = manager as unknown as {
    sessionId: string;
    cwd: string;
    fileEntries: FileEntry[];
    byId: Map<string, SessionEntry>;
    labelsById: Map<string, string>;
    labelTimestampsById: Map<string, string>;
    leafId: string | null;
    flushed: boolean;
    _buildIndex: () => void;
    _rewriteFile: () => void;
  };
  mutable.sessionId = header.id;
  mutable.cwd = header.cwd;
  mutable.fileEntries = [header, ...entries];
  mutable._buildIndex();
  mutable._rewriteFile();
  mutable.flushed = true;
}

function importLegacyLocalMessages(db: Database, tabId: string, sessionDir: string): void {
  const path = join(sessionDir, LOCAL_CHAT_FILE);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const messages = parseLocalChatLines(raw.split(/\r?\n/));
  for (const message of messages) {
    persistLocalChatMessage(db, tabId, message);
  }
  rebuildLocalSearchIndex(db, tabId);
}

function importLegacySessionFile(db: Database, tabId: string, path: string, mtimeMs: number): void {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const header = parseSessionLine(lines[0] ?? "");
  if (!isSessionHeader(header)) return;
  const existing = db.query("SELECT 1 FROM sessions WHERE session_id = ?").get(header.id);
  if (existing) return;
  const entries = lines.slice(1).flatMap((line) => {
    const entry = parseSessionLine(line);
    return isSessionEntry(entry) ? [entry] : [];
  });
  const cwd = typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
  const createdAt = parseTime(header.timestamp) ?? mtimeMs;
  const lastEntry = entries[entries.length - 1];
  db.query(
    `INSERT INTO session_tabs(tab_id, cwd, metadata_json, last_modified)
     VALUES (?, ?, '{}', ?)
     ON CONFLICT(tab_id) DO UPDATE SET
       cwd = COALESCE(session_tabs.cwd, excluded.cwd),
       last_modified = MAX(session_tabs.last_modified, excluded.last_modified)`,
  ).run(tabId, cwd ?? null, mtimeMs);
  db.query(
    `INSERT INTO sessions(session_id, tab_id, cwd, current_leaf_entry_id, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    header.id,
    tabId,
    cwd ?? null,
    lastEntry?.id ?? null,
    JSON.stringify({ header }),
    createdAt,
    mtimeMs,
  );
  entries.forEach((entry, index) => {
    persistEntryAtOrdinal(db, tabId, header.id, entry, index, {
      touch: false,
    });
  });
}

export function importLegacySessionDir(sessionDir: string): boolean {
  const db = openDb();
  if (!db) return false;
  const tabId = sessionTabIdFromDir(sessionDir);
  try {
    const entries = readdirSync(sessionDir);
    for (const name of entries) {
      if (name === LOCAL_CHAT_FILE || !name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        importLegacySessionFile(db, tabId, path, stat.mtimeMs);
      } catch {
        /* best effort per file */
      }
    }
    importLegacyLocalMessages(db, tabId, sessionDir);
    return true;
  } catch {
    return false;
  }
}

export function importLegacySessionsDir(sessionsDir: string): boolean {
  const db = openDb();
  if (!db) return false;
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) continue;
      const sessionDir = join(sessionsDir, name);
      try {
        if (statSync(sessionDir).isDirectory()) importLegacySessionDir(sessionDir);
      } catch {
        /* best effort per tab */
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function createSqliteBackedSessionManager(
  manager: SessionManager,
  tabId: string,
  cwd: string,
): SessionManager {
  const db = openDb();
  if (!db) return manager;
  const sessionsDir = process.env.AETHON_SESSIONS_DIR;
  if (typeof sessionsDir === "string" && sessionsDir.length > 0) {
    importLegacySessionDir(join(sessionsDir, tabId));
  }
  const { header, entries } = loadSessionRows(db, tabId, cwd);
  rebuildSidecar(manager, header, entries);
  const mutable = manager as unknown as {
    getEntries: () => SessionEntry[];
    getEntry: (id: string) => SessionEntry | undefined;
    getHeader: () => SessionHeader | null;
    getBranch: (fromId?: string) => SessionEntry[];
    buildSessionContext: () => unknown;
    appendMessage: (message: Message | unknown) => string;
    appendThinkingLevelChange: (thinkingLevel: string) => string;
    appendModelChange: (provider: string, modelId: string) => string;
    appendCompaction: <T>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean) => string;
    appendCustomEntry: (customType: string, data?: unknown) => string;
    appendSessionInfo: (name: string) => string;
    appendCustomMessageEntry: <T>(customType: string, content: string | unknown[], display: boolean, details?: T) => string;
    appendLabelChange?: (targetId: string, label: string | undefined) => string;
    branch: (branchFromId: string) => void;
    resetLeaf: () => void;
    branchWithSummary: (branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean) => string;
    getTree: () => SessionTreeNode[];
    getSessionName: () => string | undefined;
  };
  const persistById = (id: string): string => {
    const entry = manager.getEntry(id);
    if (entry) persistEntry(db, tabId, header.id, entry);
    return id;
  };
  const originalAppendMessage = mutable.appendMessage.bind(manager);
  mutable.appendMessage = (message) => persistById(originalAppendMessage(message));
  const originalThinking = mutable.appendThinkingLevelChange.bind(manager);
  mutable.appendThinkingLevelChange = (thinkingLevel) => persistById(originalThinking(thinkingLevel));
  const originalModel = mutable.appendModelChange.bind(manager);
  mutable.appendModelChange = (provider, modelId) => persistById(originalModel(provider, modelId));
  const originalCompaction = mutable.appendCompaction.bind(manager);
  mutable.appendCompaction = (summary, firstKeptEntryId, tokensBefore, details, fromHook) =>
    persistById(originalCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook));
  const originalCustom = mutable.appendCustomEntry.bind(manager);
  mutable.appendCustomEntry = (customType, data) => persistById(originalCustom(customType, data));
  const originalInfo = mutable.appendSessionInfo.bind(manager);
  mutable.appendSessionInfo = (name) => persistById(originalInfo(name));
  const originalCustomMessage = mutable.appendCustomMessageEntry.bind(manager);
  mutable.appendCustomMessageEntry = (customType, content, display, details) =>
    persistById(originalCustomMessage(customType, content, display, details));
  if (mutable.appendLabelChange) {
    const originalLabel = mutable.appendLabelChange.bind(manager);
    mutable.appendLabelChange = (targetId, label) => persistById(originalLabel(targetId, label));
  }
  const originalBranch = mutable.branch.bind(manager);
  mutable.branch = (branchFromId) => {
    originalBranch(branchFromId);
    db.query("UPDATE sessions SET current_leaf_entry_id = ?, updated_at = ? WHERE session_id = ?").run(
      branchFromId,
      nowMs(),
      header.id,
    );
  };
  const originalResetLeaf = mutable.resetLeaf.bind(manager);
  mutable.resetLeaf = () => {
    originalResetLeaf();
    db.query("UPDATE sessions SET current_leaf_entry_id = NULL, updated_at = ? WHERE session_id = ?").run(
      nowMs(),
      header.id,
    );
  };
  const originalBranchWithSummary = mutable.branchWithSummary.bind(manager);
  mutable.branchWithSummary = (branchFromId, summary, details, fromHook) =>
    persistById(originalBranchWithSummary(branchFromId, summary, details, fromHook));
  return manager;
}

export function sessionTabIdFromDir(sessionDir: string): string {
  return basename(sessionDir);
}

export function readSqliteStateValue(key: string): string | undefined {
  const db = openDb();
  if (!db) return undefined;
  return rowString(
    db
      .query("SELECT value FROM kv_store WHERE namespace = 'state' AND key = ?")
      .get(key),
    "value",
  );
}

export function readSqliteSessionMetadata(tabId: string): SessionLogMetadata | null {
  const db = openDb();
  if (!db) return null;
  const row = db.query("SELECT cwd, custom_label, first_user_message, last_modified FROM session_tabs WHERE tab_id = ?").get(tabId);
  if (!row) return null;
  return {
    lastModified: typeof row.last_modified === "number" ? row.last_modified : nowMs(),
    ...(rowString(row, "cwd") ? { cwd: rowString(row, "cwd") } : {}),
    ...(rowString(row, "first_user_message") ? { firstUserMessage: rowString(row, "first_user_message") } : {}),
    ...(rowString(row, "custom_label") ? { customLabel: rowString(row, "custom_label") } : {}),
  };
}

export function listSqliteDiscoveredTabs(): Array<{ tabId: string } & SessionLogMetadata> | null {
  const db = openDb();
  if (!db) return null;
  return db
    .query("SELECT tab_id, cwd, custom_label, first_user_message, last_modified FROM session_tabs ORDER BY last_modified DESC")
    .all()
    .flatMap((row) => {
      const tabId = rowString(row, "tab_id");
      if (!tabId) return [];
      return [{
        tabId,
        lastModified: typeof row.last_modified === "number" ? row.last_modified : nowMs(),
        ...(rowString(row, "cwd") ? { cwd: rowString(row, "cwd") } : {}),
        ...(rowString(row, "first_user_message") ? { firstUserMessage: rowString(row, "first_user_message") } : {}),
        ...(rowString(row, "custom_label") ? { customLabel: rowString(row, "custom_label") } : {}),
      }];
    });
}

function localRowToMessage(row: Record<string, unknown>): RestoredChatMessage | undefined {
  const raw = rowString(row, "payload_json");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RestoredChatMessage;
  } catch {
    return undefined;
  }
}

function piEntryToMessage(entry: SessionEntry): RestoredChatMessage | undefined {
  if (entry.type === "compaction") {
    return {
      id: `compaction:${entry.id}`,
      role: "system",
      text: `Context compacted · ${entry.tokensBefore.toLocaleString()} tokens summarized`,
      entryId: entry.id,
      createdAt: parseTime(entry.timestamp),
    };
  }
  if (entry.type !== "message") return undefined;
  const role = entry.message.role === "assistant" ? "agent" : entry.message.role;
  if (!isChatRole(role)) return undefined;
  const text = trimText(textFromContent(entry.message.content));
  const thinking = trimText(thinkingFromContent(entry.message.content));
  return {
    id: entry.id,
    entryId: entry.id,
    role,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    createdAt: parseTime(entry.timestamp),
  };
}

export function readSqliteSessionTranscript(tabId: string, expectedCwd?: string): RestoredChatMessage[] | null {
  const transcript = readSqliteSessionStreams(tabId, expectedCwd);
  if (!transcript) return null;
  return [...transcript.piMessages, ...transcript.localMessages]
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(-200);
}

export function readSqliteSessionStreams(tabId: string, expectedCwd?: string): {
  piMessages: RestoredChatMessage[];
  localMessages: RestoredChatMessage[];
} | null {
  const db = openDb();
  if (!db) return null;
  const session = expectedCwd !== undefined
    ? db
        .query("SELECT session_id, current_leaf_entry_id, cwd FROM sessions WHERE tab_id = ? ORDER BY updated_at DESC")
        .all(tabId)
        .find((row) => sessionMatchesCwd(rowString(row, "cwd"), expectedCwd)) ?? null
    : db
        .query("SELECT session_id, current_leaf_entry_id FROM sessions WHERE tab_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(tabId);
  const sessionId = rowString(session, "session_id");
  const currentLeafEntryId = rowString(session, "current_leaf_entry_id");
  const piMessages = sessionId
    ? activeSessionEntries(
        db.query("SELECT payload_json FROM session_entries WHERE session_id = ? ORDER BY ordinal ASC")
          .all(sessionId)
          .flatMap((row) => {
            const raw = rowString(row, "payload_json");
            if (!raw) return [];
            try {
              return [JSON.parse(raw) as SessionEntry];
            } catch {
              return [];
            }
          }),
        currentLeafEntryId,
      ).flatMap((entry) => {
        const message = piEntryToMessage(entry);
        return message ? [message] : [];
      })
    : [];
  const localRows = expectedCwd !== undefined
    ? db
        .query("SELECT payload_json, cwd FROM session_local_messages WHERE tab_id = ? ORDER BY created_at ASC")
        .all(tabId)
        .filter((row) => sessionMatchesCwd(rowString(row, "cwd"), expectedCwd))
    : db
        .query("SELECT payload_json FROM session_local_messages WHERE tab_id = ? ORDER BY created_at ASC")
        .all(tabId);
  const localMessages = localRows
    .flatMap((row) => {
      const message = localRowToMessage(row);
      return message ? [message] : [];
    });
  return { piMessages, localMessages };
}

export function readSqliteSessionLabel(tabId: string): string | undefined {
  const db = openDb();
  if (!db) return undefined;
  return rowString(db.query("SELECT custom_label FROM session_tabs WHERE tab_id = ?").get(tabId), "custom_label");
}

export function writeSqliteSessionLabel(tabId: string, label: string, cwd?: string): boolean {
  const db = openDb();
  if (!db) return false;
  const trimmed = label.trim().slice(0, MAX_CUSTOM_LABEL_CHARS);
  db.query(
    `INSERT INTO session_tabs(tab_id, cwd, custom_label, label_cwd, metadata_json, last_modified)
     VALUES (?, ?, ?, ?, '{}', ?)
     ON CONFLICT(tab_id) DO UPDATE SET
       custom_label = excluded.custom_label,
       label_cwd = excluded.label_cwd,
       cwd = COALESCE(session_tabs.cwd, excluded.cwd),
       last_modified = excluded.last_modified`,
  ).run(tabId, cwd ?? null, trimmed || null, cwd ?? null, nowMs());
  return true;
}

function persistLocalChatMessage(db: Database, tabId: string, message: RestoredChatMessage): boolean {
  if (!isChatRole(message.role)) return true;
  const text = typeof message.text === "string" ? trimText(message.text) : "";
  const thinking = typeof message.thinking === "string" ? trimText(message.thinking) : "";
  const attachments = parseChatAttachments(message.attachments);
  const a2ui = hasA2ui(message.a2ui) ? message.a2ui : undefined;
  if (!text && !thinking && !a2ui && attachments.length === 0) return true;
  const id = message.id || crypto.randomUUID();
  const createdAt = typeof message.createdAt === "number" && Number.isFinite(message.createdAt) ? message.createdAt : nowMs();
  const payload = {
    ...message,
    id,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(a2ui ? { a2ui } : {}),
    createdAt,
  };
  db.query(
    `INSERT OR REPLACE INTO session_local_messages(
       tab_id, message_id, role, text, thinking, created_at, cwd, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tabId, id, message.role, text, thinking, createdAt, message.cwd ?? null, JSON.stringify(payload));
  db.query("UPDATE session_tabs SET last_modified = MAX(last_modified, ?), cwd = COALESCE(cwd, ?) WHERE tab_id = ?").run(
    createdAt,
    message.cwd ?? null,
    tabId,
  );
  return true;
}

function rebuildLocalSearchIndex(db: Database, tabId: string): void {
  db.query("DELETE FROM session_search_fts WHERE tab_id = ? AND source = 'local'").run(tabId);
  const rows = db
    .query("SELECT role, text, thinking, created_at FROM session_local_messages WHERE tab_id = ? ORDER BY created_at ASC")
    .all(tabId);
  for (const row of rows) {
    const searchable = [rowString(row, "text") ?? "", rowString(row, "thinking") ?? ""]
      .filter(Boolean)
      .join("\n");
    if (!searchable) continue;
    db.query("INSERT INTO session_search_fts(tab_id, role, text, timestamp, source) VALUES (?, ?, ?, ?, 'local')").run(
      tabId,
      rowString(row, "role") ?? "",
      searchable,
      rowNumber(row, "created_at") ?? nowMs(),
    );
  }
}

export function appendSqliteLocalChatMessage(tabId: string, message: RestoredChatMessage): boolean {
  const db = openDb();
  if (!db) return false;
  if (!persistLocalChatMessage(db, tabId, message)) return false;
  const overflow = db
    .query(
      `SELECT message_id FROM session_local_messages
       WHERE tab_id = ?
       ORDER BY created_at DESC
       LIMIT -1 OFFSET ?`,
    )
    .all(tabId, MAX_LOCAL_CHAT_MESSAGES);
  for (const row of overflow) {
    const messageId = rowString(row, "message_id");
    if (messageId) {
      db.query("DELETE FROM session_local_messages WHERE tab_id = ? AND message_id = ?").run(tabId, messageId);
    }
  }
  rebuildLocalSearchIndex(db, tabId);
  return true;
}

export function truncateSqliteLocalChatAfter(tabId: string, cutoffMs: number): boolean {
  const db = openDb();
  if (!db) return false;
  db.query("DELETE FROM session_local_messages WHERE tab_id = ? AND created_at > ?").run(tabId, cutoffMs);
  rebuildLocalSearchIndex(db, tabId);
  return true;
}

export function forkSqliteSession(sourceTabId: string, destTabId: string, leafId: string, label: string, cwd?: string): boolean {
  const db = openDb();
  if (!db) return false;
  const source = db
    .query("SELECT session_id, payload_json, cwd FROM sessions WHERE tab_id = ? ORDER BY updated_at DESC")
    .all(sourceTabId)
    .find((row) => sessionMatchesCwd(rowString(row, "cwd"), cwd)) ?? null;
  const sourceSessionId = rowString(source, "session_id");
  if (!sourceSessionId) return false;
  const rows = db
    .query("SELECT payload_json FROM session_entries WHERE session_id = ? ORDER BY ordinal ASC")
    .all(sourceSessionId)
    .flatMap((row) => {
      const raw = rowString(row, "payload_json");
      if (!raw) return [];
      try {
        return [JSON.parse(raw) as SessionEntry];
      } catch {
        return [];
      }
    });
  const byId = new Map(rows.map((entry) => [entry.id, entry] as const));
  const path: SessionEntry[] = [];
  let current = byId.get(leafId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (path.length === 0) return false;
  const sessionId = crypto.randomUUID();
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: cwd ?? "",
    parentSession: sourceSessionId,
  };
  db.query(
    `INSERT OR REPLACE INTO session_tabs(tab_id, cwd, custom_label, metadata_json, last_modified)
     VALUES (?, ?, ?, '{}', ?)`,
  ).run(destTabId, cwd ?? null, label, nowMs());
  db.query(
    `INSERT INTO sessions(session_id, tab_id, cwd, current_leaf_entry_id, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, destTabId, cwd ?? null, leafId, JSON.stringify({ header }), nowMs(), nowMs());
  path.forEach((entry, index) => {
    persistEntryAtOrdinal(db, destTabId, sessionId, entry, index, {
      touch: false,
    });
  });
  return true;
}
