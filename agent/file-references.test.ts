import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandFileReferencesInPrompt,
  parseFileReferences,
  stripExpandedFileReferences,
} from "./file-references";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aethon-file-refs-"));
  outside = await mkdtemp(join(tmpdir(), "aethon-file-refs-outside-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs with spaces"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Read me\n");
  await writeFile(join(root, "src", "App.tsx"), "export const App = () => null;\n");
  await writeFile(join(root, "src", "foo.test.ts"), "export const n = 1;\n");
  await writeFile(join(root, "reviewer.md"), "review notes\n");
  await writeFile(join(root, "docs with spaces", "guide v1.md"), "space path\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("parseFileReferences", () => {
  it("parses unquoted, quoted, and escaped references", () => {
    expect(
      parseFileReferences(
        String.raw`Review @src/App.tsx and @"docs with spaces/guide v1.md" plus @docs\ with\ spaces/guide\ v1.md`,
      ).map((ref) => ref.value),
    ).toEqual([
      "src/App.tsx",
      "docs with spaces/guide v1.md",
      "docs with spaces/guide v1.md",
    ]);
  });

  it("does not parse email-style @ in the middle of a word", () => {
    expect(parseFileReferences("mail a@b.com then @README.md")).toHaveLength(1);
  });
});

describe("expandFileReferencesInPrompt", () => {
  it("expands relative and ./ file references", async () => {
    const out = await expandFileReferencesInPrompt(
      "Review @src/App.tsx and @./README.md",
      { cwd: root },
    );
    expect(out.references.map((ref) => ref.displayPath)).toEqual([
      "src/App.tsx",
      "README.md",
    ]);
    expect(out.prompt).toContain("<aethon_file_references");
    expect(out.prompt).toContain("export const App");
  });

  it("expands root-relative @/ and in-root absolute references", async () => {
    const absolute = join(root, "README.md");
    const out = await expandFileReferencesInPrompt(
      `Compare @/src/App.tsx with @${absolute}`,
      { cwd: root },
    );
    expect(out.references.map((ref) => ref.displayPath)).toEqual([
      "src/App.tsx",
      "README.md",
    ]);
  });

  it("allows canonical absolute paths inside a symlinked cwd", async () => {
    const link = `${root}-link`;
    await symlink(root, link);
    try {
      const out = await expandFileReferencesInPrompt(`Read @${join(root, "README.md")}`, {
        cwd: link,
      });
      expect(out.references[0]?.displayPath).toBe("README.md");
    } finally {
      await rm(link, { force: true });
    }
  });

  it("trims sentence punctuation without losing filename punctuation", async () => {
    const out = await expandFileReferencesInPrompt("Open @src/foo.test.ts.", {
      cwd: root,
    });
    expect(out.references[0]?.displayPath).toBe("src/foo.test.ts");
  });

  it("supports quoted paths with spaces", async () => {
    const out = await expandFileReferencesInPrompt(
      'Read @"docs with spaces/guide v1.md"',
      { cwd: root },
    );
    expect(out.references[0]?.content).toContain("space path");
  });

  it("reports missing explicit paths without failing the prompt", async () => {
    const out = await expandFileReferencesInPrompt("Read @src/Missing.ts", {
      cwd: root,
    });
    expect(out.references).toEqual([]);
    expect(out.prompt).toBe("Read @src/Missing.ts");
    expect(out.issues).toEqual([expect.stringContaining("@src/Missing.ts")]);

    const bareOut = await expandFileReferencesInPrompt("Read @tsconfig.json", {
      cwd: root,
    });
    expect(bareOut.references).toEqual([]);
    expect(bareOut.issues).toEqual([expect.stringContaining("@tsconfig.json")]);
  });

  it("reports dotted expression-style @mentions without failing the prompt", async () => {
    const prompt = "Allow the @search_result.resolved_bbl.blank? guard to continue";
    const out = await expandFileReferencesInPrompt(prompt, { cwd: root });
    expect(out.references).toEqual([]);
    expect(out.prompt).toBe(prompt);
    expect(out.issues).toEqual([
      expect.stringContaining("@search_result.resolved_bbl.blank?"),
    ]);
  });

  it("keeps valid file context when another @mention is unresolved", async () => {
    const out = await expandFileReferencesInPrompt(
      "Review @README.md and @search_result.resolved_bbl.blank?",
      { cwd: root },
    );
    expect(out.references.map((ref) => ref.displayPath)).toEqual(["README.md"]);
    expect(out.issues).toEqual([
      expect.stringContaining("@search_result.resolved_bbl.blank?"),
    ]);
    expect(out.prompt).toContain("<aethon_file_references");
  });

  it("ignores missing package-style and punctuated @mentions", async () => {
    for (const prompt of [
      "Use @mariozechner/pi-ai conventions",
      "Use @mariozechner/pi-ai.",
      "Talk to @alice.",
    ]) {
      const out = await expandFileReferencesInPrompt(prompt, { cwd: root });
      expect(out.references).toEqual([]);
      expect(out.prompt).toBe(prompt);
    }
  });

  it("reports directories and outside-root absolute paths without failing", async () => {
    const dirOut = await expandFileReferencesInPrompt("Read @src", { cwd: root });
    expect(dirOut.references).toEqual([]);
    expect(dirOut.issues).toEqual([expect.stringContaining("directory")]);

    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret\n");
    const outsideOut = await expandFileReferencesInPrompt(`Read @${outsideFile}`, {
      cwd: root,
    });
    expect(outsideOut.references).toEqual([]);
    expect(outsideOut.issues).toEqual([expect.stringContaining("outside")]);
  });

  it("does not treat a leading @subagent as a file reference", async () => {
    const out = await expandFileReferencesInPrompt(
      "@reviewer check @src/App.tsx",
      { cwd: root, subagentNames: ["reviewer"] },
    );
    expect(out.references.map((ref) => ref.displayPath)).toEqual([
      "src/App.tsx",
    ]);
  });

  it("exempts a mid-message @subagent without emitting an issue", async () => {
    const out = await expandFileReferencesInPrompt(
      "when done, have @reviewer check @src/App.tsx",
      { cwd: root, subagentNames: ["Reviewer"] },
    );
    // The subagent mention is skipped (no "not found" notice); the genuine
    // file reference alongside it still resolves.
    expect(out.references.map((ref) => ref.displayPath)).toEqual([
      "src/App.tsx",
    ]);
    expect(out.issues ?? []).toEqual([]);
  });

  it("does not treat a punctuated @subagent as a file reference", async () => {
    const out = await expandFileReferencesInPrompt(
      "please ask @reviewer. then continue",
      { cwd: root, subagentNames: ["reviewer"] },
    );
    expect(out.references).toEqual([]);
    expect(out.issues ?? []).toEqual([]);
  });

  it("still treats a path-like @name.ext as a file reference", async () => {
    const out = await expandFileReferencesInPrompt("read @reviewer.md please", {
      cwd: root,
      subagentNames: ["reviewer"],
    });
    expect(out.references[0]?.displayPath).toBe("reviewer.md");
  });

  it("does not mark exact-limit files as truncated", async () => {
    await writeFile(join(root, "exact.txt"), "12345");
    const out = await expandFileReferencesInPrompt("Read @exact.txt", {
      cwd: root,
      maxFileBytes: 5,
    });
    expect(out.references[0]?.content).toBe("12345");
    expect(out.references[0]?.truncated).toBe(false);
  });

  it("uses safe previews for binary and large files", async () => {
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "large.txt"), "x".repeat(20));
    const out = await expandFileReferencesInPrompt("Read @bin.dat @large.txt", {
      cwd: root,
      maxFileBytes: 5,
    });
    expect(out.references.find((ref) => ref.displayPath === "bin.dat")?.binary)
      .toBe(true);
    expect(out.references.find((ref) => ref.displayPath === "large.txt")?.truncated)
      .toBe(true);
  });

  it("does not classify large valid UTF-8 text as binary when preview cuts a multibyte character", async () => {
    await writeFile(join(root, "cjk.txt"), "あ".repeat(50_000));
    const out = await expandFileReferencesInPrompt("Read @cjk.txt", {
      cwd: root,
    });
    expect(out.references[0]?.binary).toBe(false);
    expect(out.references[0]?.content).toContain("あ");
    expect(out.references[0]?.truncated).toBe(true);
  });

  it("strips appended file-reference context from persisted display text", async () => {
    const out = await expandFileReferencesInPrompt("Review @README.md", {
      cwd: root,
    });
    expect(stripExpandedFileReferences(out.prompt)).toBe("Review @README.md");
  });
});
