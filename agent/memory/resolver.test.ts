import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectIdentityFromProjectsJson, resolveMemoryContext } from "./resolver";

function projectsJson(root: string, workspace: string): string {
  return JSON.stringify({
    activeId: "p1",
    projects: [{ id: "p1", label: "Aethon", path: root }],
    activeWorkspaceId: "w1",
    workspacesByProject: {
      p1: [{ id: "w1", projectId: "p1", path: workspace }],
    },
  });
}

describe("memory resolver", () => {
  it("resolves a workspace cwd to its parent Aethon project", () => {
    const id = projectIdentityFromProjectsJson(
      projectsJson("/repo/aethon", "/repo/aethon/.aethon/workspaces/feat-x"),
      "/repo/aethon/.aethon/workspaces/feat-x/src",
    );

    expect(id).toMatchObject({
      root: "/repo/aethon",
      label: "Aethon",
      source: "aethon-workspace",
      resolvedFromCwd: "/repo/aethon/.aethon/workspaces/feat-x/src",
    });
    expect(id?.key).toContain("p1");
  });

  it("falls back to the git common dir so linked worktrees share one memory scope", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-memory-"));
    const ctx = await resolveMemoryContext({
      userDir,
      cwd: "/work/repo-linked",
      readProjectsJson: () => Promise.resolve(undefined),
      git: (_cwd, args) => {
        if (args.includes("--git-common-dir")) return Promise.resolve("/work/repo/.git");
        if (args.includes("--show-toplevel")) return Promise.resolve("/work/repo-linked");
        return Promise.resolve(undefined);
      },
    });

    expect(ctx.project.project?.root).toBe("/work/repo");
    expect(ctx.project.project?.source).toBe("git-common-dir");
    expect(ctx.project.project?.key).toBe("git:/work/repo");
  });

  it("keeps the same project memory directory when only the display label changes", async () => {
    const first = projectIdentityFromProjectsJson(
      projectsJson("/repo/aethon", "/repo/aethon/.aethon/workspaces/feat-x"),
      "/repo/aethon/src",
    );
    const second = projectIdentityFromProjectsJson(
      projectsJson("/repo/aethon", "/repo/aethon/.aethon/workspaces/feat-x").replace("Aethon", "Renamed"),
      "/repo/aethon/src",
    );
    const userDir = mkdtempSync(join(tmpdir(), "aethon-memory-"));
    const firstCtx = await resolveMemoryContext({
      userDir,
      cwd: "/repo/aethon/src",
      readProjectsJson: () => Promise.resolve(JSON.stringify({ projects: [{ id: "p1", label: first?.label, path: first?.root }] })),
    });
    const secondCtx = await resolveMemoryContext({
      userDir,
      cwd: "/repo/aethon/src",
      readProjectsJson: () => Promise.resolve(JSON.stringify({ projects: [{ id: "p1", label: second?.label, path: second?.root }] })),
    });

    expect(firstCtx.project.dir).toBe(secondCtx.project.dir);
  });

  it("does not rewrite project metadata when stable identity is unchanged", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-memory-"));
    const options = {
      userDir,
      cwd: "/repo/aethon/src",
      readProjectsJson: () =>
        Promise.resolve(
          JSON.stringify({ projects: [{ id: "p1", label: "Aethon", path: "/repo/aethon" }] }),
        ),
    };

    const first = await resolveMemoryContext(options);
    const metaPath = join(first.project.dir, "meta.json");
    const firstMeta = readFileSync(metaPath, "utf8");
    const firstMtime = statSync(metaPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await resolveMemoryContext(options);

    expect(readFileSync(metaPath, "utf8")).toBe(firstMeta);
    expect(statSync(metaPath).mtimeMs).toBe(firstMtime);
    expect(firstMeta).not.toContain("resolvedFromCwd");
    expect(firstMeta).not.toContain("updatedAt");
  });

  it("creates memory files under ~/.aethon without writing to the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-memory-"));
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "projects.json"), projectsJson(join(dir, "repo"), join(dir, "repo", "wt")));

    const ctx = await resolveMemoryContext({
      userDir: dir,
      cwd: join(dir, "repo", "src"),
    });

    expect(ctx.user.memoryPath).toBe(join(dir, "memory", "user", "MEMORY.md"));
    expect(ctx.project.memoryPath).toContain(join(dir, "memory", "projects"));
    expect(ctx.project.memoryPath).not.toContain(join(dir, "repo"));
  });
});
