import { describe, expect, it } from "vitest";
import { buildWorkingContextSection } from "./working-context";

describe("buildWorkingContextSection", () => {
  it("renders cwd, branch, worktree, dirty count and ahead/behind", () => {
    const out = buildWorkingContextSection({
      cwd: "/work/repo",
      git: {
        repoRoot: "/work/main",
        branch: "feat/x",
        isWorktree: true,
        changedFiles: 5,
        ahead: 5,
        behind: 0,
      },
    });
    expect(out).toContain("Working directory: `/work/repo`");
    expect(out).toContain("Repository root: `/work/main`");
    expect(out).toContain("branch `feat/x` (worktree)");
    expect(out).toContain("5 changed files");
    expect(out).toContain("ahead 5 / behind 0");
    expect(out).toContain("Operate within this directory");
  });

  it("omits repo root when equal to cwd and reports a clean tree", () => {
    const out = buildWorkingContextSection({
      cwd: "/work/repo",
      git: {
        repoRoot: "/work/repo",
        branch: "main",
        isWorktree: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    });
    expect(out).not.toContain("Repository root:");
    expect(out).toContain("working tree clean");
    expect(out).not.toContain("ahead");
    expect(out).not.toContain("(worktree)");
  });

  it("singularizes a single changed file", () => {
    const out = buildWorkingContextSection({
      cwd: "/x",
      git: {
        repoRoot: null,
        branch: "m",
        isWorktree: false,
        changedFiles: 1,
        ahead: 0,
        behind: 0,
      },
    });
    expect(out).toContain("1 changed file");
    expect(out).not.toContain("1 changed files");
  });

  it("says not a git repository when git is null", () => {
    const out = buildWorkingContextSection({ cwd: "/tmp/x", git: null });
    expect(out).toContain("Git: not a git repository.");
  });

  it("appends a trimmed soft anchor when provided", () => {
    const out = buildWorkingContextSection({
      cwd: "/x",
      git: null,
      softAnchor: "  Only touch files under src/.  ",
    });
    expect(out.endsWith("Only touch files under src/.")).toBe(true);
  });

  it("ignores a blank soft anchor", () => {
    const out = buildWorkingContextSection({
      cwd: "/x",
      git: null,
      softAnchor: "   ",
    });
    expect(out.endsWith("unless the user explicitly asks.")).toBe(true);
  });
});
