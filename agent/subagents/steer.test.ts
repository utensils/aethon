import { describe, expect, it } from "vitest";
import {
  buildExplicitSubagentSteer,
  detectBackgroundSubagentIntent,
  detectLeadingSubagentMentions,
  detectSubagentMention,
} from "./steer";

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

describe("detectLeadingSubagentMentions", () => {
  it("detects multiple leading @name mentions joined by words or punctuation", () => {
    expect(
      detectLeadingSubagentMentions("@kimi and @glm-5-2 peer review"),
    ).toEqual(["kimi", "glm-5-2"]);
    expect(
      detectLeadingSubagentMentions(" @Reviewer, @Planner; @coder go"),
    ).toEqual(["reviewer", "planner", "coder"]);
  });

  it("keeps non-leading mentions out of whole-prompt delegation", () => {
    expect(
      detectLeadingSubagentMentions("implement it, then have @reviewer check"),
    ).toEqual([]);
  });

  it("does not treat path-like suffixes as subagent chains", () => {
    expect(detectLeadingSubagentMentions("@reviewer.md please")).toEqual([]);
    expect(detectLeadingSubagentMentions("@reviewer/check this")).toEqual([]);
  });
});

describe("detectBackgroundSubagentIntent", () => {
  it("recognizes async/background wording", () => {
    expect(detectBackgroundSubagentIntent("@kimi async review")).toBe(true);
    expect(detectBackgroundSubagentIntent("@kimi run in background")).toBe(
      true,
    );
    expect(detectBackgroundSubagentIntent("@kimi don't wait")).toBe(true);
    expect(detectBackgroundSubagentIntent("@kimi separate tabs")).toBe(true);
  });

  it("does not mark ordinary delegation as background", () => {
    expect(detectBackgroundSubagentIntent("@kimi review inline")).toBe(false);
  });
});

describe("buildExplicitSubagentSteer", () => {
  it("names the subagent and instructs delegation via the task tool", () => {
    const steer = buildExplicitSubagentSteer("reviewer");
    expect(steer).toContain('"reviewer"');
    expect(steer).toContain("task");
    expect(steer).toContain('subagent_type="reviewer"');
  });

  it("instructs batch delegation when multiple subagents are named", () => {
    const steer = buildExplicitSubagentSteer(["kimi", "glm-5-2"]);
    expect(steer).toContain("task_batch");
    expect(steer).toContain('"kimi"');
    expect(steer).toContain('"glm-5-2"');
    expect(steer).toContain('surface="inline"');
  });

  it("requests background tabs only when the user asked for them", () => {
    const steer = buildExplicitSubagentSteer(["kimi", "glm-5-2"], {
      surface: "background",
    });
    expect(steer).toContain("task_batch");
    expect(steer).toContain('surface="background"');
    expect(steer).toContain("non-focused");
  });
});
