import { describe, expect, it } from "vitest";
import {
  normalizeAgentMessage,
  normalizeAgentMessageForDisplay,
} from "./agentResponseNormalizer";
import type { ChatMessage } from "../types/a2ui";

describe("normalizeAgentMessageForDisplay", () => {
  it("moves pseudo-tool reasoning into thinking and renders proposed commands inertly", () => {
    const out = normalizeAgentMessageForDisplay({
      role: "agent",
      text: JSON.stringify({
        analysis: "Need to inspect the repo.",
        plan: "Run a search.",
        commands: [{ tool: "bash", args: { cmd: "rg foo" } }],
      }),
    });

    expect(out.thinking).toContain("Analysis:\nNeed to inspect the repo.");
    expect(out.thinking).toContain("Plan:\nRun a search.");
    expect(out.text).toContain(
      "Model produced proposed tool commands, but Aethon did not execute them.",
    );
    expect(out.text).toContain('"tool": "bash"');
  });

  it("renders LFM native tool-call blocks as non-executed tool text", () => {
    const out = normalizeAgentMessageForDisplay({
      role: "agent",
      text: [
        '<|tool_call_start|>[bash({"cmd":"ls"})]<|tool_call_end|>',
        "I need the directory listing first.",
      ].join(""),
    });

    expect(out.text).toContain("I need the directory listing first.");
    expect(out.text).toContain(
      "Model produced native tool-call output, but Aethon did not execute it.",
    );
    expect(out.text).toContain('[bash({"cmd":"ls"})]');
  });

  it("shows a placeholder for partial streamed pseudo-tool envelopes", () => {
    const out = normalizeAgentMessageForDisplay({
      role: "agent",
      text: '{"analysis":"still thinking","commands"',
    });

    expect(out.text).toBe(
      "Model is emitting a structured tool-plan envelope. Waiting for the final answer...",
    );
  });

  it("leaves non-agent and a2ui messages untouched", () => {
    expect(
      normalizeAgentMessageForDisplay({
        role: "user",
        text: '{"analysis":"literal"}',
      }),
    ).toEqual({ text: '{"analysis":"literal"}', thinking: undefined });
    expect(
      normalizeAgentMessageForDisplay({
        role: "agent",
        text: '{"analysis":"literal"}',
        a2ui: { components: [] },
      }),
    ).toEqual({ text: '{"analysis":"literal"}', thinking: undefined });
  });
});

describe("normalizeAgentMessage", () => {
  it("returns an updated chat message for restored pseudo-tool envelopes", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "agent",
      text: '{"analysis":"think","final":"Done"}',
    };

    expect(normalizeAgentMessage(msg)).toMatchObject({
      id: "m1",
      role: "agent",
      text: "Done",
      thinking: "Analysis:\nthink",
    });
  });
});
