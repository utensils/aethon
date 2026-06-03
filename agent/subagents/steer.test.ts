import { describe, expect, it } from "vitest";
import { buildExplicitSubagentSteer, detectSubagentMention } from "./steer";

describe("detectSubagentMention", () => {
  it("detects a leading @name", () => {
    expect(detectSubagentMention("@reviewer check this")).toBe("reviewer");
    expect(detectSubagentMention("@code-reviewer_2 go")).toBe(
      "code-reviewer_2",
    );
  });
  it("lowercases the name", () => {
    expect(detectSubagentMention("@Reviewer hi")).toBe("reviewer");
  });
  it("tolerates leading whitespace", () => {
    expect(detectSubagentMention("   @planner do x")).toBe("planner");
  });
  it("returns null without a leading mention", () => {
    expect(detectSubagentMention("hello @reviewer")).toBeNull();
    expect(detectSubagentMention("no mention")).toBeNull();
    expect(detectSubagentMention("@ bad")).toBeNull();
    expect(detectSubagentMention("")).toBeNull();
  });
  it("stops at subagent punctuation but not path-like suffixes", () => {
    expect(detectSubagentMention("@reviewer, please")).toBe("reviewer");
    expect(detectSubagentMention("@reviewer.")).toBe("reviewer");
    expect(detectSubagentMention("@reviewer.md please")).toBeNull();
    expect(detectSubagentMention("@reviewer/check this")).toBeNull();
  });
});

describe("buildExplicitSubagentSteer", () => {
  it("names the subagent and instructs delegation via the task tool", () => {
    const steer = buildExplicitSubagentSteer("reviewer");
    expect(steer).toContain('"reviewer"');
    expect(steer).toContain("task");
    expect(steer).toContain('subagent_type="reviewer"');
  });
});
