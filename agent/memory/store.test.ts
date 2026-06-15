import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetMemoryEntry, readMemoryFile, rememberEntry } from "./store";
import type { ResolvedMemoryScope } from "./types";

function scope(dir: string): ResolvedMemoryScope {
  return {
    scope: "project",
    dir,
    memoryPath: join(dir, "MEMORY.md"),
    topicsDir: join(dir, "topics"),
    project: {
      id: "proj-123",
      key: "project:/repo",
      root: "/repo",
      label: "repo",
      source: "cwd",
      resolvedFromCwd: "/repo",
    },
  };
}

describe("memory store", () => {
  it("appends durable entries with ids and avoids duplicate text", async () => {
    const s = scope(mkdtempSync(join(tmpdir(), "aethon-memory-store-")));

    const first = await rememberEntry(s, {
      kind: "instruction",
      text: "Always run focused tests before broad gates.",
      tags: ["testing"],
    });
    const second = await rememberEntry(s, {
      kind: "instruction",
      text: "Always run focused tests before broad gates.",
      tags: ["testing"],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const text = await readFile(s.memoryPath, "utf8");
    expect(text.match(/Always run focused tests/g)).toHaveLength(1);
    expect(text).toContain(`<!-- id: ${first.id}`);
  });

  it("serializes concurrent remembers so entries are not lost", async () => {
    const s = scope(mkdtempSync(join(tmpdir(), "aethon-memory-store-")));

    await Promise.all([
      rememberEntry(s, { kind: "fact", text: "The API test suite needs Redis." }),
      rememberEntry(s, { kind: "fact", text: "The UI test suite needs Playwright." }),
    ]);

    const text = await readMemoryFile(s);
    expect(text).toContain("The API test suite needs Redis.");
    expect(text).toContain("The UI test suite needs Playwright.");
  });

  it("waits for an inter-process lock before writing", async () => {
    const s = scope(mkdtempSync(join(tmpdir(), "aethon-memory-store-")));
    mkdirSync(`${s.memoryPath}.lock`, { recursive: true });

    const pending = rememberEntry(s, { kind: "fact", text: "Locked writes eventually persist." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readMemoryFile(s)).not.toContain("Locked writes eventually persist.");

    rmSync(`${s.memoryPath}.lock`, { recursive: true, force: true });
    await pending;
    expect(await readMemoryFile(s)).toContain("Locked writes eventually persist.");
  });

  it("removes entries by id", async () => {
    const s = scope(mkdtempSync(join(tmpdir(), "aethon-memory-store-")));
    const entry = await rememberEntry(s, { kind: "preference", text: "Prefer Nix over Homebrew." });

    const removed = await forgetMemoryEntry(s, { id: entry.id });

    expect(removed.removed).toBe(1);
    expect(await readMemoryFile(s)).not.toContain("Prefer Nix");
  });
});
