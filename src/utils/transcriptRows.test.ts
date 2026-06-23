import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  findRowIndexForMessageId,
  heightEstimateForRow,
  rowKey,
  searchableTextForRow,
} from "./transcriptRows";
import type { ChatMessage } from "../types/a2ui";

function text(id: string, role: ChatMessage["role"] = "agent"): ChatMessage {
  return { id, role, text: `msg ${id}` };
}

function tool(id: string, opts: { running?: boolean } = {}): ChatMessage {
  const props: Record<string, unknown> = { title: "bash", startedAt: 1 };
  if (!opts.running) props.endedAt = 2;
  return {
    id,
    role: "agent",
    a2ui: { components: [{ id: `c-${id}`, type: "tool-card", props }] },
  };
}

const rowTypes = (messages: ChatMessage[], expanded: Iterable<string> = []) =>
  buildTranscriptRows(messages, "group-block", new Set(expanded)).rows.map(
    (row) => row.type,
  );

describe("buildTranscriptRows", () => {
  it("keeps collapsed turn blocks as one virtual row by default", () => {
    const messages = [
      text("u1", "user"),
      text("a1"),
      tool("t1"),
      tool("t2"),
      text("u2", "user"),
      tool("t3"),
    ];

    const model = buildTranscriptRows(messages, "group-block", new Set());

    expect(model.rows.map(rowKey)).toEqual([
      "msg-u1",
      "turnblock-a1",
      "msg-u2",
      "msg-t3",
    ]);
    expect(model.heightEstimates).toEqual(
      model.rows.map((row) => heightEstimateForRow(row)),
    );
  });

  it("flattens expanded turn blocks into summary and child virtual rows", () => {
    const messages = [
      text("u1", "user"),
      text("a1"),
      tool("t1"),
      tool("t2"),
      text("u2", "user"),
      tool("t3"),
    ];

    expect(rowTypes(messages, ["turnblock-a1"])).toEqual([
      "message",
      "turn-block-summary",
      "turn-block-child",
      "turn-block-child",
      "turn-block-child",
      "message",
      "message",
    ]);
  });

  it("flattens expanded tool groups into summary and tool child rows", () => {
    const messages = [text("u1", "user"), tool("t1"), tool("t2"), text("a1")];

    const model = buildTranscriptRows(
      messages,
      "group-run",
      new Set(["toolgroup-t1"]),
    );

    expect(model.rows.map((row) => row.type)).toEqual([
      "message",
      "tool-group-summary",
      "tool-group-child",
      "tool-group-child",
      "message",
    ]);
    expect(model.rows.map(rowKey)).toEqual([
      "msg-u1",
      "toolgroup-t1",
      "toolgroup-t1:child:t1",
      "toolgroup-t1:child:t2",
      "msg-a1",
    ]);
  });

  it("anchors message ids inside expanded and collapsed rows", () => {
    const messages = [
      text("u1", "user"),
      text("a1"),
      tool("t1"),
      tool("t2"),
      text("u2", "user"),
      tool("t3"),
    ];

    const collapsed = buildTranscriptRows(messages, "group-block", new Set());
    expect(findRowIndexForMessageId(collapsed.rows, "t2")).toBe(1);

    const expanded = buildTranscriptRows(
      messages,
      "group-block",
      new Set(["turnblock-a1"]),
    );
    expect(findRowIndexForMessageId(expanded.rows, "t2")).toBe(4);
  });

  it("keeps collapsed summary rows searchable over hidden turn text and tool metadata", () => {
    const messages = [
      text("u1", "user"),
      { ...text("a1"), text: "The hidden migration finished" },
      {
        ...tool("t1"),
        a2ui: {
          components: [
            {
              id: "c-t1",
              type: "tool-card",
              props: {
                title: "bash",
                description: "cargo test hidden-output",
                startedAt: 1,
                endedAt: 2,
              },
            },
          ],
        },
      },
      text("u2", "user"),
      tool("t2"),
    ];

    const model = buildTranscriptRows(messages, "group-block", new Set());
    const summary = model.rows[1];

    expect(summary.type).toBe("turn-block-summary");
    expect(searchableTextForRow(summary)).toContain("hidden migration");
    expect(searchableTextForRow(summary)).toContain("cargo test hidden-output");
  });

  it("keeps running tool cards visible as normal message rows", () => {
    const messages = [
      text("u1", "user"),
      tool("t1"),
      tool("t2", { running: true }),
      text("u2", "user"),
      tool("t3"),
    ];

    expect(rowTypes(messages)).toEqual([
      "message",
      "message",
      "message",
      "message",
      "message",
    ]);
  });
});
