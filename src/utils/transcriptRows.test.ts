import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  findRowIndexForMessageId,
  heightEstimateForRow,
  rowKey,
  searchableTextForRow,
} from "./transcriptRows";
import type { ChatMessage } from "../types/a2ui";

function text(
  id: string,
  role: ChatMessage["role"] = "agent",
  value = `msg ${id}`,
): ChatMessage {
  return { id, role, text: value };
}

function tool(
  id: string,
  opts: { running?: boolean; description?: string } = {},
): ChatMessage {
  const props: Record<string, unknown> = {
    title: "bash",
    description: opts.description ?? "bun test",
    startedAt: 1,
  };
  if (!opts.running) props.endedAt = 2;
  return {
    id,
    role: "agent",
    a2ui: { components: [{ id: `c-${id}`, type: "tool-card", props }] },
  };
}

describe("buildTranscriptRows", () => {
  it("builds one virtual row per conversation turn", () => {
    const messages = [
      text("u1", "user"),
      text("a1"),
      tool("t1"),
      text("a2"),
      text("u2", "user"),
      tool("t2"),
      text("a3"),
    ];

    const model = buildTranscriptRows(messages, "group-block", new Set());

    expect(model.rows.map(rowKey)).toEqual(["turn-u1", "turn-u2"]);
    expect(model.groups.map((turn) => turn.messages.map((m) => m.id))).toEqual([
      ["u1", "a1", "t1", "a2"],
      ["u2", "t2", "a3"],
    ]);
    expect(model.heightEstimates).toEqual(
      model.rows.map((row) => heightEstimateForRow(row)),
    );
  });

  it("keeps the latest assistant prose as the visible final answer", () => {
    const model = buildTranscriptRows(
      [
        text("u1", "user", "Please fix this"),
        text("a1", "agent", "I will inspect it"),
        tool("t1"),
        text("a2", "agent", "Fixed and verified."),
      ],
      "group-block",
      new Set(),
    );

    const turn = model.rows[0].turn;
    expect(turn.userMessage?.id).toBe("u1");
    expect(turn.finalMessage?.id).toBe("a2");
    expect(turn.progressMessages.map((message) => message.id)).toEqual(["a1"]);
    expect(turn.toolMessages.map((message) => message.id)).toEqual(["t1"]);
  });

  it("preserves running tool cards inside the active turn", () => {
    const model = buildTranscriptRows(
      [
        text("u1", "user"),
        tool("t1"),
        tool("t2", { running: true }),
        text("a1"),
      ],
      "group-run",
      new Set(),
    );

    expect(model.rows).toHaveLength(1);
    expect(
      model.rows[0].turn.toolMessages.map((message) => message.id),
    ).toEqual(["t1", "t2"]);
  });

  it("hides tool messages in hide mode while keeping answer/progress structure", () => {
    const model = buildTranscriptRows(
      [
        text("u1", "user"),
        text("a1", "agent", "checking"),
        tool("t1"),
        text("a2", "agent", "done"),
      ],
      "hide",
      new Set(),
    );

    const turn = model.rows[0].turn;
    expect(turn.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "a2",
    ]);
    expect(turn.toolMessages).toEqual([]);
    expect(turn.progressMessages.map((message) => message.id)).toEqual(["a1"]);
    expect(turn.finalMessage?.id).toBe("a2");
  });

  it("anchors any message id back to the containing turn row", () => {
    const model = buildTranscriptRows(
      [
        text("u1", "user"),
        text("a1"),
        tool("t1"),
        text("u2", "user"),
        tool("t2"),
      ],
      "group-block",
      new Set(),
    );

    expect(findRowIndexForMessageId(model.rows, "t1")).toBe(0);
    expect(findRowIndexForMessageId(model.rows, "u2")).toBe(1);
  });

  it("keeps hidden progress and tool metadata searchable", () => {
    const model = buildTranscriptRows(
      [
        text("u1", "user"),
        text("a1", "agent", "The hidden migration finished"),
        tool("t1", { description: "cargo test hidden-output" }),
        text("a2", "agent", "All set"),
      ],
      "group-block",
      new Set(),
    );

    const textValue = searchableTextForRow(model.rows[0]);
    expect(textValue).toContain("hidden migration");
    expect(textValue).toContain("cargo test hidden-output");
  });
});
