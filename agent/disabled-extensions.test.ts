import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disabledExtensionsFile,
  loadDisabledExtensions,
  loadDisabledExtensionsSnapshot,
  saveDisabledExtensions,
  saveDisabledExtensionsSnapshot,
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
      // Sorted on disk so the file is stable across writes. The legacy
      // name-only saver writes the enriched object shape with no meta —
      // round-tripping back through `loadDisabledExtensions` still
      // recovers the same names.
      const text = readFileSync(disabledExtensionsFile(dir), "utf8");
      expect(JSON.parse(text)).toEqual({
        disabled: [{ name: "a-ext" }, { name: "b-ext" }],
      });
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

  it("round-trips enriched entries through snapshot save + load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      await saveDisabledExtensionsSnapshot(dir, {
        names: new Set(["mold:image-gallery", "@mold/repo-gallery", "legacy"]),
        meta: new Map([
          [
            "mold:image-gallery",
            { source: "project-directory", projectRoot: "/repo/mold" },
          ],
          ["@mold/repo-gallery", { source: "extension-package" }],
          // `legacy` intentionally omitted to mirror an entry the user
          // disabled before the metadata schema existed.
        ]),
      });
      const text = readFileSync(disabledExtensionsFile(dir), "utf8");
      expect(JSON.parse(text)).toEqual({
        disabled: [
          { name: "@mold/repo-gallery", source: "extension-package" },
          { name: "legacy" },
          {
            name: "mold:image-gallery",
            source: "project-directory",
            projectRoot: "/repo/mold",
          },
        ],
      });
      const snapshot = await loadDisabledExtensionsSnapshot(dir);
      expect([...snapshot.names].sort()).toEqual([
        "@mold/repo-gallery",
        "legacy",
        "mold:image-gallery",
      ]);
      expect(snapshot.meta.get("mold:image-gallery")).toEqual({
        source: "project-directory",
        projectRoot: "/repo/mold",
      });
      expect(snapshot.meta.get("@mold/repo-gallery")).toEqual({
        source: "extension-package",
      });
      expect(snapshot.meta.has("legacy")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads legacy string-array files into the snapshot with empty meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      const file = disabledExtensionsFile(dir);
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        file,
        JSON.stringify({ disabled: ["a-ext", "b-ext"] }),
        "utf8",
      );
      const snapshot = await loadDisabledExtensionsSnapshot(dir);
      expect([...snapshot.names].sort()).toEqual(["a-ext", "b-ext"]);
      expect(snapshot.meta.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops entries whose source string is unrecognized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-dis-"));
    try {
      const file = disabledExtensionsFile(dir);
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        file,
        JSON.stringify({
          disabled: [
            { name: "x", source: "not-a-real-source" },
            { name: "y", source: "directory" },
          ],
        }),
        "utf8",
      );
      const snapshot = await loadDisabledExtensionsSnapshot(dir);
      expect([...snapshot.names].sort()).toEqual(["x", "y"]);
      // `x` had an unknown source — name kept (so the loader still skips
      // it), metadata dropped (so the sidebar treats it as global).
      expect(snapshot.meta.has("x")).toBe(false);
      expect(snapshot.meta.get("y")).toEqual({ source: "directory" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
