import { describe, expect, it } from "vitest";
import { buildBuiltinSlashCommands, parseSlashCommand } from "./slashCommands";

describe("parseSlashCommand", () => {
  it("returns null for plain text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  it("returns null for the literal-slash escape `//`", () => {
    expect(parseSlashCommand("//literal")).toBeNull();
  });

  it("parses a command with no args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  it("parses a command with args", () => {
    expect(parseSlashCommand("/theme dark")).toEqual({
      name: "theme",
      args: "dark",
    });
  });

  it("preserves multi-line args (slash commands can span lines)", () => {
    const parsed = parseSlashCommand("/help line1\nline2");
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("help");
    expect(parsed!.args).toBe("line1\nline2");
  });

  it("trims leading whitespace before the slash", () => {
    expect(parseSlashCommand("   /clear")).toEqual({ name: "clear", args: "" });
  });

  it("rejects names that start with a digit", () => {
    expect(parseSlashCommand("/9invalid")).toBeNull();
  });

  it("accepts names with hyphens and underscores", () => {
    expect(parseSlashCommand("/foo-bar_baz")).toEqual({
      name: "foo-bar_baz",
      args: "",
    });
  });
});

describe("buildBuiltinSlashCommands", () => {
  it("returns at least the documented built-ins", () => {
    const names = buildBuiltinSlashCommands().map((c) => c.name);
    for (const expected of [
      "clear",
      "help",
      "theme",
      "model",
      "reset",
      "terminal",
      "skills",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("every built-in carries a description", () => {
    for (const cmd of buildBuiltinSlashCommands()) {
      expect(typeof cmd.description).toBe("string");
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("every built-in has a run() handler", () => {
    for (const cmd of buildBuiltinSlashCommands()) {
      expect(typeof cmd.run).toBe("function");
    }
  });
});
