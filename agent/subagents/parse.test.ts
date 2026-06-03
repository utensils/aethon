import { describe, expect, it } from "vitest";
import {
  isSafeSubagentName,
  parseSubagentMarkdown,
  resolveSubagentTools,
  sanitizeSubagentName,
} from "./parse";

const ctx = {
  filePath: "/agents/reviewer.md",
  scope: "user" as const,
  name: "reviewer",
};

describe("isSafeSubagentName", () => {
  it("accepts lowercase slugs", () => {
    expect(isSafeSubagentName("reviewer")).toBe(true);
    expect(isSafeSubagentName("code-reviewer_2")).toBe(true);
    expect(isSafeSubagentName("a")).toBe(true);
  });
  it("rejects unsafe names", () => {
    expect(isSafeSubagentName("")).toBe(false);
    expect(isSafeSubagentName("-leading")).toBe(false);
    expect(isSafeSubagentName("UPPER")).toBe(false);
    expect(isSafeSubagentName("has space")).toBe(false);
    expect(isSafeSubagentName("../escape")).toBe(false);
    expect(isSafeSubagentName("x".repeat(65))).toBe(false);
  });
});

describe("sanitizeSubagentName", () => {
  it("slugifies arbitrary input", () => {
    expect(sanitizeSubagentName("Code Reviewer")).toBe("code-reviewer");
    expect(sanitizeSubagentName("  My Agent!!  ")).toBe("my-agent");
    expect(sanitizeSubagentName("__trim__")).toBe("trim");
  });
  it("returns empty when nothing usable remains", () => {
    expect(sanitizeSubagentName("!!!")).toBe("");
    expect(sanitizeSubagentName("   ")).toBe("");
  });
  it("clamps to 64 chars", () => {
    expect(sanitizeSubagentName("a".repeat(100)).length).toBe(64);
  });
});

describe("parseSubagentMarkdown", () => {
  it("parses a full definition", () => {
    const raw = [
      "---",
      "description: Reviews diffs for correctness",
      "model: ollama/llama3.3",
      "tools: [read, grep, bash]",
      "surface: inline",
      "timeout: 900",
      "---",
      "You are a meticulous code reviewer.",
      "Focus on edge cases.",
    ].join("\n");
    const { subagent, error } = parseSubagentMarkdown(raw, ctx);
    expect(error).toBeUndefined();
    expect(subagent).toEqual({
      name: "reviewer",
      description: "Reviews diffs for correctness",
      model: "ollama/llama3.3",
      tools: ["read", "grep", "bash"],
      surface: "inline",
      timeoutSeconds: 900,
      systemPrompt: "You are a meticulous code reviewer.\nFocus on edge cases.",
      scope: "user",
      filePath: "/agents/reviewer.md",
    });
  });

  it("requires a description", () => {
    const raw = "---\nmodel: gpt-5.5\n---\nbody";
    const { subagent, error } = parseSubagentMarkdown(raw, ctx);
    expect(subagent).toBeUndefined();
    expect(error).toMatch(/description/);
  });

  it("requires frontmatter", () => {
    const { error } = parseSubagentMarkdown("just a body, no frontmatter", ctx);
    expect(error).toMatch(/frontmatter/);
  });

  it("reports invalid YAML", () => {
    const raw = "---\ndescription: ok\ntools: [unterminated\n---\nbody";
    const { subagent, error } = parseSubagentMarkdown(raw, ctx);
    expect(subagent).toBeUndefined();
    expect(error).toMatch(/invalid YAML/);
  });

  it("rejects a non-mapping frontmatter", () => {
    const raw = "---\n- just\n- a\n- list\n---\nbody";
    const { error } = parseSubagentMarkdown(raw, ctx);
    expect(error).toMatch(/mapping/);
  });

  it("defaults surface to inline and tools to inherit", () => {
    const raw = "---\ndescription: d\n---\nbody";
    const { subagent } = parseSubagentMarkdown(raw, ctx);
    expect(subagent?.surface).toBe("inline");
    expect(subagent?.tools).toBeUndefined();
    expect(subagent?.model).toBeUndefined();
    expect(subagent?.timeoutSeconds).toBeUndefined();
  });

  it("honors surface: tab", () => {
    const raw = "---\ndescription: d\nsurface: tab\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.surface).toBe("tab");
  });

  it("rejects invalid timeout frontmatter", () => {
    const raw = "---\ndescription: d\ntimeout: nope\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).error).toMatch(/timeout/);
  });

  it("floors fractional timeout frontmatter to at least one second", () => {
    const raw = "---\ndescription: d\ntimeout: 0.5\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.timeoutSeconds).toBe(1);
  });

  it("clamps timeout frontmatter to the maximum", () => {
    const raw = "---\ndescription: d\ntimeout: 999999\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.timeoutSeconds).toBe(
      86400,
    );
  });

  it("treats an unknown surface as inline", () => {
    const raw = "---\ndescription: d\nsurface: floating\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.surface).toBe("inline");
  });

  it("parses tools as a comma-separated string", () => {
    const raw = "---\ndescription: d\ntools: read, grep , bash\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.tools).toEqual([
      "read",
      "grep",
      "bash",
    ]);
  });

  it("treats an empty tools list as 'no tools'", () => {
    const raw = "---\ndescription: d\ntools: []\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.tools).toEqual([]);
  });

  it("treats an empty tools string as 'no tools'", () => {
    const raw = '---\ndescription: d\ntools: ""\n---\nbody';
    expect(parseSubagentMarkdown(raw, ctx).subagent?.tools).toEqual([]);
  });

  it("dedupes tools and preserves order", () => {
    const raw = "---\ndescription: d\ntools: [read, grep, read]\n---\nbody";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.tools).toEqual([
      "read",
      "grep",
    ]);
  });

  it("tolerates CRLF line endings and a BOM", () => {
    const raw = "﻿---\r\ndescription: d\r\n---\r\nbody line\r\n";
    const { subagent, error } = parseSubagentMarkdown(raw, ctx);
    expect(error).toBeUndefined();
    expect(subagent?.systemPrompt).toBe("body line");
  });

  it("trims the system prompt body", () => {
    const raw = "---\ndescription: d\n---\n\n\n  hello  \n\n";
    expect(parseSubagentMarkdown(raw, ctx).subagent?.systemPrompt).toBe(
      "hello",
    );
  });

  it("supports an empty body", () => {
    const raw = "---\ndescription: d\n---\n";
    const { subagent, error } = parseSubagentMarkdown(raw, ctx);
    expect(error).toBeUndefined();
    expect(subagent?.systemPrompt).toBe("");
  });
});

describe("resolveSubagentTools", () => {
  it("inherits when tools is undefined", () => {
    expect(resolveSubagentTools({ tools: undefined })).toEqual({});
  });
  it("locks down to no tools when empty", () => {
    expect(resolveSubagentTools({ tools: [] })).toEqual({ noTools: "all" });
  });
  it("passes through an allowlist", () => {
    expect(resolveSubagentTools({ tools: ["read", "bash"] })).toEqual({
      tools: ["read", "bash"],
    });
  });
});
