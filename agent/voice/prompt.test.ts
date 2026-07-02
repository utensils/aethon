import { describe, expect, it } from "vitest";
import {
  VOICE_BRAIN_PREAMBLE,
  buildTaskEventPrompt,
  buildTurnPrompt,
  stripUnspeakable,
} from "./prompt";

describe("buildTurnPrompt", () => {
  it("includes the preamble only when asked", () => {
    const first = buildTurnPrompt("hello", {}, true);
    const later = buildTurnPrompt("hello", {}, false);
    expect(first).toContain(VOICE_BRAIN_PREAMBLE);
    expect(later).not.toContain(VOICE_BRAIN_PREAMBLE);
    expect(later).toContain("The user said (via voice): hello");
  });

  it("carries the runtime context block when present", () => {
    const prompt = buildTurnPrompt(
      "fix the tests",
      { projectPath: "/repo/aethon", defaultModel: "anthropic/claude-x" },
      false,
    );
    expect(prompt).toContain("active project: /repo/aethon");
    expect(prompt).toContain("work-agent model: anthropic/claude-x");
    expect(prompt).toContain("The user said (via voice): fix the tests");
  });

  it("omits the context block when empty", () => {
    expect(buildTurnPrompt("hi", {}, false)).not.toContain("[runtime context]");
  });
});

describe("buildTaskEventPrompt", () => {
  it("frames a completion with the report between markers", () => {
    const prompt = buildTaskEventPrompt({
      type: "voice_task_event",
      taskTabId: "tab-3",
      label: "fix flaky test",
      status: "completed",
      finalText: "All tests pass now.",
    });
    expect(prompt).toContain('The task "fix flaky test" finished');
    expect(prompt).toContain("<report>\nAll tests pass now.\n</report>");
    expect(prompt).toContain("[system note — not the user speaking]");
  });

  it("marks errors and survives an empty report", () => {
    const prompt = buildTaskEventPrompt({
      type: "voice_task_event",
      taskTabId: "tab-7",
      status: "error",
      finalText: "",
    });
    expect(prompt).toContain("in tab tab-7 finished with an error");
    expect(prompt).toContain("no text report");
  });

  it("drops fenced code from the report", () => {
    const prompt = buildTaskEventPrompt({
      type: "voice_task_event",
      taskTabId: "tab-1",
      status: "completed",
      finalText: "Done.\n```rust\nfn main() {}\n```\nTests green.",
    });
    expect(prompt).not.toContain("fn main");
    expect(prompt).toContain("Done.");
    expect(prompt).toContain("Tests green.");
  });

  it("frames progress events as a one-sentence update request", () => {
    const prompt = buildTaskEventPrompt({
      type: "voice_task_event",
      taskTabId: "tab-3",
      label: "audit the auth flow",
      status: "progress",
      finalText: "Reading the session middleware.",
    });
    expect(prompt).toContain('The task "audit the auth flow" is still working');
    expect(prompt).toContain(
      "<activity>\nReading the session middleware.\n</activity>",
    );
    expect(prompt).toContain("one short spoken sentence");
    expect(prompt).not.toContain("finished");
  });
});

describe("VOICE_BRAIN_PREAMBLE", () => {
  it("forbids asking the user questions and mandates dispatch-first", () => {
    expect(VOICE_BRAIN_PREAMBLE).toContain("Never ask the user questions");
    expect(VOICE_BRAIN_PREAMBLE).not.toContain("clarifying question");
  });
});

describe("stripUnspeakable", () => {
  it("removes closed and unterminated fences", () => {
    expect(stripUnspeakable("a ```x``` b")).toBe("a  (code omitted)  b");
    expect(stripUnspeakable("a ```never closed")).toBe("a  (code omitted) ");
  });
});
