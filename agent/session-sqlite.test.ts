import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSqliteDiscoveredTabs,
  readSqliteSessionMetadata,
  readSqliteSessionTranscript,
  setSqliteDatabaseCtorForTests,
} from "./session-sqlite";

type SessionTabRow = {
  tab_id: string;
  cwd: string;
  custom_label: string;
  first_user_message: string;
  last_modified: number;
};
type SessionRow = {
  tab_id: string;
  session_id: string;
  current_leaf_entry_id?: string;
  cwd?: string;
};
type SessionEntryRow = {
  session_id: string;
  payload_json: string;
};
type LocalMessageRow = {
  tab_id: string;
  cwd?: string;
  payload_json: string;
  created_at: number;
};

let root: string;
let previousDbFile: string | undefined;
let rows: SessionTabRow[];
let sessionRows: SessionRow[];
let sessionEntryRows: SessionEntryRow[];
let localMessageRows: LocalMessageRow[];

class FakeDatabase {
  constructor(_path: string) {}

  exec(_sql: string): void {}

  query(sql: string) {
    if (sql.includes("FROM session_tabs WHERE tab_id = ?")) {
      return {
        get: (tabId: string) =>
          rows.find((row) => row.tab_id === tabId) ?? null,
        all: () => [],
        run: () => undefined,
      };
    }
    if (sql.includes("FROM session_tabs ORDER BY last_modified DESC")) {
      return {
        get: () => null,
        all: () => [...rows].sort((a, b) => b.last_modified - a.last_modified),
        run: () => undefined,
      };
    }
    if (
      sql.includes("FROM sessions WHERE tab_id = ? ORDER BY updated_at DESC")
    ) {
      return {
        get: (tabId: string) =>
          sessionRows.find((row) => row.tab_id === tabId) ?? null,
        all: (tabId: string) =>
          sessionRows.filter((row) => row.tab_id === tabId),
        run: () => undefined,
      };
    }
    if (
      sql.includes(
        "FROM session_entries WHERE session_id = ? ORDER BY ordinal ASC",
      )
    ) {
      return {
        get: () => null,
        all: (sessionId: string) =>
          sessionEntryRows.filter((row) => row.session_id === sessionId),
        run: () => undefined,
      };
    }
    if (
      sql.includes(
        "FROM session_local_messages WHERE tab_id = ? ORDER BY created_at ASC",
      )
    ) {
      return {
        get: () => null,
        all: (tabId: string) =>
          localMessageRows
            .filter((row) => row.tab_id === tabId)
            .sort((a, b) => a.created_at - b.created_at),
        run: () => undefined,
      };
    }
    throw new Error(`unexpected SQL in fake database: ${sql}`);
  }

  close(): void {}
}

beforeEach(() => {
  previousDbFile = process.env.AETHON_DB_FILE;
  root = mkdtempSync(join(tmpdir(), "aethon-session-sqlite-"));
  process.env.AETHON_DB_FILE = join(root, "state.sqlite3");
  rows = [];
  sessionRows = [];
  sessionEntryRows = [];
  localMessageRows = [];
  setSqliteDatabaseCtorForTests(FakeDatabase);
});

afterEach(() => {
  setSqliteDatabaseCtorForTests(undefined);
  if (previousDbFile === undefined) {
    delete process.env.AETHON_DB_FILE;
  } else {
    process.env.AETHON_DB_FILE = previousDbFile;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("SQLite session metadata", () => {
  it("reports cwdExists for individual session metadata and discovered tabs", () => {
    const existingCwd = join(root, "existing-workspace");
    const missingCwd = join(root, "missing-workspace");
    mkdirSync(existingCwd);
    rows = [
      {
        tab_id: "missing-tab",
        cwd: missingCwd,
        custom_label: "missing-tab label",
        first_user_message: "missing-tab first",
        last_modified: 1000,
      },
      {
        tab_id: "existing-tab",
        cwd: existingCwd,
        custom_label: "existing-tab label",
        first_user_message: "existing-tab first",
        last_modified: 2000,
      },
    ];

    expect(readSqliteSessionMetadata("existing-tab")).toMatchObject({
      cwd: existingCwd,
      cwdExists: true,
      customLabel: "existing-tab label",
      firstUserMessage: "existing-tab first",
      lastModified: 2000,
    });
    expect(readSqliteSessionMetadata("missing-tab")).toMatchObject({
      cwd: missingCwd,
      cwdExists: false,
      lastModified: 1000,
    });

    expect(listSqliteDiscoveredTabs()).toEqual([
      expect.objectContaining({
        tabId: "existing-tab",
        cwd: existingCwd,
        cwdExists: true,
      }),
      expect.objectContaining({
        tabId: "missing-tab",
        cwd: missingCwd,
        cwdExists: false,
      }),
    ]);
  });

  it("merges ordered pi and local transcripts without dropping older messages", () => {
    sessionRows = [
      {
        tab_id: "tab-1",
        session_id: "session-1",
        current_leaf_entry_id: undefined,
      },
    ];
    sessionEntryRows = [
      {
        session_id: "session-1",
        payload_json: JSON.stringify(piMessage("pi-1", "user", "pi early", 10)),
      },
      {
        session_id: "session-1",
        payload_json: JSON.stringify(
          piMessage("pi-2", "assistant", "pi late", 30),
        ),
      },
    ];
    localMessageRows = [
      {
        tab_id: "tab-1",
        payload_json: JSON.stringify({
          id: "local-1",
          role: "user",
          text: "local middle",
          createdAt: 20,
        }),
        created_at: 20,
      },
      {
        tab_id: "tab-1",
        payload_json: JSON.stringify({
          id: "local-2",
          role: "agent",
          text: "local latest",
          createdAt: 40,
        }),
        created_at: 40,
      },
    ];

    expect(
      readSqliteSessionTranscript("tab-1")?.map((message) => message.id),
    ).toEqual(["pi-1", "local-1", "pi-2", "local-2"]);
  });
});

function piMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
) {
  return {
    id,
    type: "message",
    timestamp: new Date(createdAt).toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}
