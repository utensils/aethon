import { describe, expect, it } from "vitest";
import { splitThinkingBlocks } from "./thinkingBlocks";

describe("splitThinkingBlocks", () => {
  it("splits complete thinking tags out of normal text", () => {
    expect(splitThinkingBlocks("before <thinking>hidden</thinking> after")).toEqual([
      { type: "text", content: "before " },
      { type: "thinking", content: "hidden", closed: true },
      { type: "text", content: " after" },
    ]);
  });

  it("supports short think tags", () => {
    expect(splitThinkingBlocks("<think>plan</think>\nanswer")).toEqual([
      { type: "thinking", content: "plan", closed: true },
      { type: "text", content: "\nanswer" },
    ]);
  });

  it("keeps an unclosed block as streaming thinking content", () => {
    expect(splitThinkingBlocks("hello <thinking>still going")).toEqual([
      { type: "text", content: "hello " },
      { type: "thinking", content: "still going", closed: false },
    ]);
  });

  it("leaves plain text unchanged", () => {
    expect(splitThinkingBlocks("plain")).toEqual([
      { type: "text", content: "plain" },
    ]);
  });
});
