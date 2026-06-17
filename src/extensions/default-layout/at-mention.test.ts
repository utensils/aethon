import { describe, expect, it } from "vitest";
import {
  AT_MATCH_LIMIT,
  atMentionRoot,
  findActiveAtToken,
  formatAtInsertion,
  formatAtMentionInsertion,
  isLeadingAtToken,
  matchAtMentions,
  matchAtSubagents,
  matchAtFiles,
  shouldOfferAgents,
  subagentSuggestionsFromFiles,
  type AtFileMatch,
  type AtSubagentMatch,
} from "./at-mention";
import type { SubagentFile } from "../../subagents";

function files(...rels: string[]): AtFileMatch[] {
  return rels.map((rel) => ({ rel, path: `/proj/${rel}` }));
}

function agent(
  name: string,
  description = `${name} helper`,
  extra: Partial<AtSubagentMatch> = {},
): AtSubagentMatch {
  return {
    kind: "agent",
    name,
    description,
    surface: "inline",
    ...extra,
  };
}

function subagentFile(
  scope: SubagentFile["scope"],
  name: string,
  description: string,
): SubagentFile {
  return {
    scope,
    name,
    filePath: `/agents/${name}.md`,
    content: `---\ndescription: ${description}\n---\nYou help.\n`,
  };
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
      ...Array.from(
        { length: 30 },
        (_, i) => `file-${String(i).padStart(2, "0")}.ts`,
      ),
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

describe("subagent mention matching", () => {
  it("detects when the active token is the leading message token", () => {
    const leading = findActiveAtToken("   @kimi review", 8);
    expect(leading).not.toBeNull();
    expect(isLeadingAtToken("   @kimi review", leading!)).toBe(true);

    const later = findActiveAtToken("hello @kimi", 11);
    expect(later).not.toBeNull();
    expect(isLeadingAtToken("hello @kimi", later!)).toBe(false);
  });

  it("offers agents for leading tokens and any non-empty name fragment", () => {
    const offer = (value: string, cursor: number): boolean => {
      const token = findActiveAtToken(value, cursor);
      expect(token).not.toBeNull();
      return shouldOfferAgents(value, token!);
    };
    // Leading `@` (even with no query yet) — the delegation prefix.
    expect(offer("@", 1)).toBe(true);
    expect(offer("@ki", 3)).toBe(true);
    // Mid-message mention with a name fragment still completes to an agent.
    expect(offer("hello @ki", 9)).toBe(true);
    // Bare mid-message `@` stays file-focused (no agent clutter).
    expect(offer("hello @", 7)).toBe(false);
  });

  it("surfaces a subagent for a mid-message mention via shouldOfferAgents", () => {
    const value = "when done have @glm";
    const token = findActiveAtToken(value, value.length);
    expect(token).not.toBeNull();
    const matches = matchAtMentions({
      query: token!.query,
      files: files("src/glmd.ts"),
      subagents: [agent("glm-5-2", "zhipu coding model")],
      includeAgents: shouldOfferAgents(value, token!),
    });
    expect(matches[0]).toMatchObject({ kind: "agent", name: "glm-5-2" });
  });

  it("ranks matching subagents by name and description", () => {
    const result = matchAtSubagents("ki", [
      agent("reviewer", "checks diffs"),
      agent("kimi", "moonshot code model"),
    ]);
    expect(result.map((m) => m.name)).toEqual(["kimi"]);
  });

  it("does not suggest agents for file-shaped tokens", () => {
    expect(matchAtSubagents("reviewer.md", [agent("reviewer")])).toEqual([]);
    expect(matchAtSubagents("reviewer/check", [agent("reviewer")])).toEqual([]);
  });

  it("shows agents first only for leading tokens and keeps files elsewhere", () => {
    const leading = matchAtMentions({
      query: "ki",
      files: files("src/kitchen.ts"),
      subagents: [agent("kimi", "review code")],
      includeAgents: true,
    });
    expect(leading.map((m) => m.kind)).toEqual(["agent", "file"]);

    const midDraft = matchAtMentions({
      query: "ki",
      files: files("src/kitchen.ts"),
      subagents: [agent("kimi", "review code")],
      includeAgents: false,
    });
    expect(midDraft.map((m) => m.kind)).toEqual(["file"]);
  });

  it("merges user and project subagents with project winning by name", () => {
    const result = subagentSuggestionsFromFiles([
      subagentFile("user", "reviewer", "user reviewer"),
      subagentFile("project", "reviewer", "project reviewer"),
      subagentFile("user", "kimi", "moonshot model"),
    ]);
    expect(result.map((m) => [m.name, m.description])).toEqual([
      ["kimi", "moonshot model"],
      ["reviewer", "project reviewer"],
    ]);
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

describe("formatAtMentionInsertion", () => {
  it("formats agent mentions with a trailing space", () => {
    expect(formatAtMentionInsertion(agent("kimi"))).toBe("@kimi ");
  });

  it("delegates file suggestions to the file reference formatter", () => {
    expect(
      formatAtMentionInsertion({
        kind: "file",
        rel: "docs/my file.md",
        path: "/proj/docs/my file.md",
      }),
    ).toBe('@"docs/my file.md" ');
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
