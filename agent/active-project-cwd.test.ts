import { describe, expect, it } from "vitest";
import {
  activeProjectCwdFromJson,
  resolveStartupCwd,
} from "./active-project-cwd";

describe("activeProjectCwdFromJson", () => {
  it("uses the active project path when no workspace is active", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          projects: [{ id: "p1", path: "/repo/app" }],
        }),
      ),
    ).toBe("/repo/app");
  });

  it("prefers the active workspace path when present", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          activeWorkspaceId: "wt1",
          projects: [{ id: "p1", path: "/repo/aethon" }],
          workspacesByProject: {
            p1: [{ id: "wt1", projectId: "p1", path: "/repo/aethon-fix" }],
          },
        }),
      ),
    ).toBe("/repo/aethon-fix");
  });

  it("reads pre-v5 worktree spellings on an upgrade boot (regression)", () => {
    // The bridge can start against a projects.json the frontend hasn't
    // re-saved in the v5 schema yet. The old keys must still resolve the
    // active workspace cwd, or the agent boots in the project root and
    // loads the wrong extensions / session scope.
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          schemaVersion: 4,
          activeId: "p1",
          activeWorktreeId: "wt1",
          projects: [{ id: "p1", path: "/repo/aethon" }],
          worktreesByProject: {
            p1: [{ id: "wt1", projectId: "p1", path: "/repo/aethon-fix" }],
          },
        }),
      ),
    ).toBe("/repo/aethon-fix");
  });

  it("falls back to the project path when the active workspace is stale", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          activeWorkspaceId: "missing",
          projects: [{ id: "p1", path: "/repo/app" }],
          workspacesByProject: { p1: [] },
        }),
      ),
    ).toBe("/repo/app");
  });

  it("returns undefined for malformed project state", () => {
    expect(activeProjectCwdFromJson("{nope")).toBeUndefined();
  });
});

describe("resolveStartupCwd", () => {
  it("uses active project, then dev project root, then user dir, then process cwd", () => {
    expect(
      resolveStartupCwd(
        "/repo/project",
        "/repo/aethon",
        "/Users/me/.aethon",
        "/",
      ),
    ).toBe("/repo/project");
    expect(
      resolveStartupCwd(undefined, "/repo/aethon", "/Users/me/.aethon", "/"),
    ).toBe("/repo/aethon");
    expect(
      resolveStartupCwd(undefined, undefined, "/Users/me/.aethon", "/"),
    ).toBe("/Users/me/.aethon");
    expect(resolveStartupCwd(undefined, undefined, "", "/")).toBe("/");
  });
});

describe("readActiveProjectCwd", () => {
  it("degrades to the on-disk projects.json when the state db is unopenable", async () => {
    // SQLITE_CANTOPEN from readSqliteStateValue used to escape and fatal
    // the whole bridge boot before the dispatcher started.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readActiveProjectCwd } = await import("./active-project-cwd");

    const userDir = mkdtempSync(join(tmpdir(), "aethon-cwd-"));
    try {
      // Point the sqlite reader at an unopenable path: AETHON_DB_FILE's
      // parent directory does not exist.
      const priorDb = process.env.AETHON_DB_FILE;
      process.env.AETHON_DB_FILE = join(userDir, "missing-dir", "aethon.sqlite3");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "projects.json"),
        JSON.stringify({
          activeId: "p1",
          projects: [{ id: "p1", path: "/repo/fallback" }],
        }),
      );
      await expect(readActiveProjectCwd(userDir)).resolves.toBe(
        "/repo/fallback",
      );
      if (priorDb === undefined) delete process.env.AETHON_DB_FILE;
      else process.env.AETHON_DB_FILE = priorDb;
    } finally {
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
