import { describe, expect, it } from "vitest";
import {
  groupMessages,
  isToolCardMessage,
  isRunningToolCard,
  type MessageGroup,
} from "./toolCardGrouping";
import type { ChatMessage } from "../types/a2ui";

function text(id: string): ChatMessage {
  return { id, role: "agent", text: `msg ${id}` };
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

const kinds = (groups: MessageGroup[]) => groups.map((g) => g.type);

describe("isToolCardMessage / isRunningToolCard", () => {
  it("detects tool cards and running state", () => {
    expect(isToolCardMessage(tool("a"))).toBe(true);
    expect(isToolCardMessage(text("a"))).toBe(false);
    expect(isRunningToolCard(tool("a", { running: true }))).toBe(true);
    expect(isRunningToolCard(tool("a"))).toBe(false);
    expect(isRunningToolCard(text("a"))).toBe(false);
  });
});

describe("groupMessages", () => {
  const messages = [
    text("u1"),
    tool("t1"),
    tool("t2"),
    tool("t3"),
    text("a1"),
    tool("t4"),
  ];

  it("show → one single per message", () => {
    const groups = groupMessages(messages, "show");
    expect(groups).toHaveLength(messages.length);
    expect(groups.every((g) => g.type === "single")).toBe(true);
  });

  it("hide → drops tool-card messages entirely", () => {
    const groups = groupMessages(messages, "hide");
    expect(groups.map((g) => (g.type === "single" ? g.message.id : g.id))).toEqual([
      "u1",
      "a1",
    ]);
  });

  it("collapse → folds consecutive completed tool cards into one cluster", () => {
    const groups = groupMessages(messages, "collapse");
    // u1(single) | [t1,t2,t3](group) | a1(single) | t4(single, lone)
    expect(kinds(groups)).toEqual(["single", "tool-group", "single", "single"]);
    const cluster = groups[1];
    expect(cluster.type === "tool-group" && cluster.messages.map((m) => m.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(cluster.type === "tool-group" && cluster.id).toBe("toolgroup-t1");
  });

  it("collapse → a lone tool card stays a single (no cluster wrapper)", () => {
    const groups = groupMessages([text("u1"), tool("t1"), text("a1")], "collapse");
    expect(kinds(groups)).toEqual(["single", "single", "single"]);
  });

  it("collapse → keeps a running tool card ungrouped so live progress shows", () => {
    const groups = groupMessages(
      [tool("t1"), tool("t2"), tool("t3", { running: true })],
      "collapse",
    );
    // t1+t2 group; the running t3 stays a single after the cluster.
    expect(kinds(groups)).toEqual(["tool-group", "single"]);
  });
});
