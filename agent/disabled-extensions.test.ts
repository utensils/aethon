import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disabledExtensionsFile,
  loadDisabledExtensions,
  saveDisabledExtensions,
} from "./disabled-extensions";

describe("disabled-extensions persistence", () => {
  it("loads an empty set when the file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      const set = await loadDisabledExtensions(dir);
      expect(set.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips through save + load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      await saveDisabledExtensions(dir, new Set(["b-ext", "a-ext"]));
      // Sorted on disk so the file is stable across writes.
      const text = readFileSync(disabledExtensionsFile(dir), "utf8");
      expect(JSON.parse(text)).toEqual({ disabled: ["a-ext", "b-ext"] });
      const loaded = await loadDisabledExtensions(dir);
      expect([...loaded].sort()).toEqual(["a-ext", "b-ext"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the destination is unwritable so the caller can revert", async () => {
    // Point at a path that can't be created — a regular file used as
    // the parent dir. mkdir(file/...) errors with ENOTDIR, which we
    // want to propagate so the dispatcher refuses the toggle.
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      const fs = await import("node:fs/promises");
      const sentinelFile = join(dir, "not-a-dir");
      await fs.writeFile(sentinelFile, "i am a file", "utf8");
      await expect(
        saveDisabledExtensions(sentinelFile, new Set(["x"])),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed JSON gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      // Write garbage.
      const file = disabledExtensionsFile(dir);
      const fs = await import("node:fs/promises");
      await fs.writeFile(file, "{not json", "utf8");
      const set = await loadDisabledExtensions(dir);
      expect(set.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
