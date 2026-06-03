import { describe, expect, it } from "vitest";
import {
  isSafeSubagentName,
  parseSubagentContent,
  sanitizeSubagentName,
  serializeSubagent,
  type SubagentFields,
} from "./parse";

describe("isSafeSubagentName / sanitizeSubagentName", () => {
  it("validates names", () => {
    expect(isSafeSubagentName("reviewer")).toBe(true);
    expect(isSafeSubagentName("code-reviewer_2")).toBe(true);
    expect(isSafeSubagentName("UPPER")).toBe(false);
    expect(isSafeSubagentName("-x")).toBe(false);
    expect(isSafeSubagentName("")).toBe(false);
  });
  it("sanitizes user input", () => {
    expect(sanitizeSubagentName("Code Reviewer")).toBe("code-reviewer");
    expect(sanitizeSubagentName("!!!")).toBe("");
  });
});

describe("parseSubagentContent", () => {
  it("parses a full definition", () => {
    const raw = [
      "---",
      "description: Reviews diffs",
      "model: ollama/llama3.3",
      "tools: [read, grep]",
      "surface: tab",
      "timeout: 900",
      "---",
      "You review code.",
    ].join("\n");
    const { fields, error } = parseSubagentContent(raw);
    expect(error).toBeUndefined();
    expect(fields).toEqual({
      description: "Reviews diffs",
      model: "ollama/llama3.3",
      tools: ["read", "grep"],
      surface: "tab",
      timeoutSeconds: 900,
      systemPrompt: "You review code.",
    });
  });

  it("requires a description", () => {
    const { error } = parseSubagentContent("---\nmodel: x\n---\nbody");
    expect(error).toMatch(/description/);
  });

  it("requires frontmatter", () => {
    expect(parseSubagentContent("no frontmatter").error).toMatch(/frontmatter/);
  });

  it("defaults surface to inline and tools to inherit", () => {
    const { fields } = parseSubagentContent("---\ndescription: d\n---\nbody");
    expect(fields?.surface).toBe("inline");
    expect(fields?.tools).toBeUndefined();
    expect(fields?.model).toBeUndefined();
    expect(fields?.timeoutSeconds).toBeUndefined();
  });

  it("treats an empty tools list as none", () => {
    const { fields } = parseSubagentContent(
      "---\ndescription: d\ntools: []\n---\nb",
    );
    expect(fields?.tools).toEqual([]);
  });

  it("rejects invalid timeout frontmatter", () => {
    const { error } = parseSubagentContent(
      "---\ndescription: d\ntimeout: nope\n---\nbody",
    );
    expect(error).toMatch(/timeout/);
  });

  it("floors fractional timeout frontmatter to at least one second", () => {
    const { fields, error } = parseSubagentContent(
      "---\ndescription: d\ntimeout: 0.5\n---\nbody",
    );
    expect(error).toBeUndefined();
    expect(fields?.timeoutSeconds).toBe(1);
  });
});

describe("serializeSubagent", () => {
  const base: SubagentFields = {
    description: "Reviews diffs",
    model: "ollama/llama3.3",
    tools: ["read", "grep"],
    surface: "tab",
    timeoutSeconds: 900,
    systemPrompt: "You review.",
  };

  it("round-trips through parse", () => {
    const text = serializeSubagent(base);
    const { fields, error } = parseSubagentContent(text);
    expect(error).toBeUndefined();
    expect(fields).toEqual(base);
  });

  it("omits default surface and inherited tools", () => {
    const text = serializeSubagent({
      description: "d",
      surface: "inline",
      systemPrompt: "body",
    });
    expect(text).not.toContain("surface:");
    expect(text).not.toContain("tools:");
    expect(text).not.toContain("timeout:");
    expect(text).toContain("description: d");
    const { fields } = parseSubagentContent(text);
    expect(fields?.surface).toBe("inline");
    expect(fields?.tools).toBeUndefined();
  });

  it("serializes an empty tools list (none) round-trip", () => {
    const text = serializeSubagent({
      description: "d",
      tools: [],
      surface: "inline",
      systemPrompt: "",
    });
    const { fields } = parseSubagentContent(text);
    expect(fields?.tools).toEqual([]);
  });
});
