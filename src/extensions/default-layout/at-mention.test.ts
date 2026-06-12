import { describe, expect, it } from "vitest";
import {
  AT_MATCH_LIMIT,
  atMentionRoot,
  findActiveAtToken,
  formatAtInsertion,
  matchAtFiles,
  type AtFileMatch,
} from "./at-mention";

function files(...rels: string[]): AtFileMatch[] {
  return rels.map((rel) => ({ rel, path: `/proj/${rel}` }));
}

describe("findActiveAtToken", () => {
  it("matches a bare @ at the start of the draft", () => {
    expect(findActiveAtToken("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("captures the query between @ and the cursor", () => {
    expect(findActiveAtToken("@src/app", 8)).toEqual({
      query: "src/app",
      start: 0,
      end: 8,
    });
  });

  it("matches a token mid-draft after whitespace", () => {
    expect(findActiveAtToken("look at @chat", 13)).toEqual({
      query: "chat",
      start: 8,
      end: 13,
    });
  });

  it("allows opening brackets and quotes before the @", () => {
    expect(findActiveAtToken("(@src", 5)).toMatchObject({ query: "src" });
  });

  it("never triggers inside an email address", () => {
    const value = "mail me@example.com";
    expect(findActiveAtToken(value, value.length)).toBeNull();
  });

  it("does not match once whitespace follows the token", () => {
    expect(findActiveAtToken("@src foo", 8)).toBeNull();
  });

  it("extends end to the rest of the token when the cursor sits inside", () => {
    expect(findActiveAtToken("@src", 2)).toEqual({
      query: "s",
      start: 0,
      end: 4,
    });
  });

  it("stops the token at trailing whitespace", () => {
    expect(findActiveAtToken("@src more", 4)).toEqual({
      query: "src",
      start: 0,
      end: 4,
    });
  });

  it("strips a hand-typed leading quote from the query", () => {
    expect(findActiveAtToken('@"src', 5)).toMatchObject({ query: "src" });
  });

  it("returns null without an @ before the cursor", () => {
    expect(findActiveAtToken("hello", 5)).toBeNull();
    expect(findActiveAtToken("", 0)).toBeNull();
  });
});

describe("matchAtFiles", () => {
  it("ranks basename prefix matches above scattered path hits", () => {
    const result = matchAtFiles(
      "app",
      files("docs/notes/snappy.md", "src/App.tsx"),
    );
    expect(result[0]?.rel).toBe("src/App.tsx");
  });

  it("matches across the full relative path", () => {
    const result = matchAtFiles("src/app", files("src/App.tsx", "README.md"));
    expect(result.map((f) => f.rel)).toEqual(["src/App.tsx"]);
  });

  it("returns the walk ordering for an empty query, capped", () => {
    const many = files(
      ...Array.from({ length: 30 }, (_, i) => `file-${String(i).padStart(2, "0")}.ts`),
    );
    const result = matchAtFiles("", many);
    expect(result).toHaveLength(AT_MATCH_LIMIT);
    expect(result[0]?.rel).toBe("file-00.ts");
  });

  it("caps scored results at the limit", () => {
    const many = files(
      ...Array.from({ length: 30 }, (_, i) => `src/app-${i}.ts`),
    );
    expect(matchAtFiles("app", many)).toHaveLength(AT_MATCH_LIMIT);
  });

  it("returns empty when nothing matches", () => {
    expect(matchAtFiles("zzz", files("src/App.tsx"))).toEqual([]);
  });
});

describe("formatAtInsertion", () => {
  it("inserts plain paths with a trailing space", () => {
    expect(formatAtInsertion("src/App.tsx")).toBe("@src/App.tsx ");
  });

  it("quotes paths containing whitespace", () => {
    expect(formatAtInsertion("docs/my file.md")).toBe('@"docs/my file.md" ');
  });

  it("escapes quotes and backslashes inside quoted paths", () => {
    expect(formatAtInsertion('we"ird file.md')).toBe('@"we\\"ird file.md" ');
  });
});

describe("atMentionRoot", () => {
  it("prefers the active tab's recorded cwd", () => {
    expect(
      atMentionRoot({
        activeTabId: "t1",
        tabs: [{ id: "t1", cwd: "/tab/cwd" }],
        project: { path: "/proj" },
      }),
    ).toBe("/tab/cwd");
  });

  it("falls back to the active project path", () => {
    expect(
      atMentionRoot({
        activeTabId: "t1",
        tabs: [{ id: "t1" }],
        project: { path: "/proj" },
      }),
    ).toBe("/proj");
  });

  it("returns null with no root at all", () => {
    expect(atMentionRoot({})).toBeNull();
  });
});
