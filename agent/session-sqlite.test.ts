import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSqliteDiscoveredTabs,
  readSqliteSessionMetadata,
  setSqliteDatabaseCtorForTests,
} from "./session-sqlite";

type SessionTabRow = {
  tab_id: string;
  cwd: string;
  custom_label: string;
  first_user_message: string;
  last_modified: number;
};

let root: string;
let previousDbFile: string | undefined;
let rows: SessionTabRow[];

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
        all: () =>
          [...rows].sort((a, b) => b.last_modified - a.last_modified),
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
});
