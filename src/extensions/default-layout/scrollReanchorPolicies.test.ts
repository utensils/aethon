import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/a2ui";
import { buildTranscriptRows, type TranscriptRow } from "../../utils/transcriptRows";
import {
  appendedUserTurnResumesFollow,
  visibilityReanchorIndex,
} from "./scrollReanchorPolicies";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "start" },
  { id: "a1", role: "agent", text: "answer" },
  {
    id: "tool1",
    role: "agent",
    a2ui: {
      components: [
        {
          id: "tool-card",
          type: "tool-card",
          props: { title: "bash", description: "hidden when tools collapse" },
        },
      ],
    },
  },
  { id: "u2", role: "user", text: "next" },
];

function rowFor(message: ChatMessage): TranscriptRow {
  return {
    type: "conversation-turn",
    turn: {
      id: message.id,
      messages: [message],
      agentMessages: message.role === "agent" ? [message] : [],
      progressMessages: [],
      toolMessages: [],
      systemMessages: [],
      ...(message.role === "user" ? { userMessage: message } : {}),
      ...(message.role === "agent" ? { finalMessage: message } : {}),
    },
  };
}

describe("scrollReanchorPolicies", () => {
  it("maps a visibility-toggle anchor to the same surviving message", () => {
    const oldRows = buildTranscriptRows(messages, "show", new Set()).rows;
    const newRows = buildTranscriptRows(messages, "group-block", new Set()).rows;

    expect(
      visibilityReanchorIndex({
        messages,
        oldRows,
        newRows,
        startIndex: 1,
      }),
    ).toBe(1);
  });

  it("falls back to the nearest preceding message when the anchor row disappears", () => {
    const oldRows = messages.map(rowFor);
    const newRows = [messages[0], messages[1], messages[3]].map(rowFor);

    expect(
      visibilityReanchorIndex({
        messages,
        oldRows,
        newRows,
        startIndex: 2,
      }),
    ).toBe(1);
  });

  it("resumes follow when any appended message after the previous tail is a user turn", () => {
    expect(
      appendedUserTurnResumesFollow({
        messages: [
          { id: "1", role: "agent", text: "old" },
          { id: "2", role: "user", text: "new prompt" },
          { id: "3", role: "agent", text: "first token" },
        ],
        previousTailId: "1",
      }),
    ).toBe(true);

    expect(
      appendedUserTurnResumesFollow({
        messages: [
          { id: "1", role: "agent", text: "old" },
          { id: "2", role: "agent", text: "streaming" },
        ],
        previousTailId: "1",
      }),
    ).toBe(false);
  });
});
