import { describe, expect, it } from "vitest";
import {
  groupMessages,
  groupKey,
  anchorMessageIdForGroup,
  findGroupIndexForMessageId,
  isToolCardMessage,
  isRunningToolCard,
  toolCardTitle,
  type MessageGroup,
} from "./toolCardGrouping";
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

const kinds = (groups: MessageGroup[]) => groups.map((g) => g.type);
const ids = (g: MessageGroup): string[] =>
  g.type === "single" ? [g.message.id] : g.messages.map((m) => m.id);

describe("isToolCardMessage / isRunningToolCard", () => {
  it("detects tool cards and running state", () => {
    expect(isToolCardMessage(tool("a"))).toBe(true);
    expect(isToolCardMessage(text("a"))).toBe(false);
    expect(isRunningToolCard(tool("a", { running: true }))).toBe(true);
    expect(isRunningToolCard(tool("a"))).toBe(false);
    expect(isRunningToolCard(text("a"))).toBe(false);
    expect(toolCardTitle(tool("a"))).toBe("bash");
  });
});

describe("groupMessages — show / hide", () => {
  const messages = [
    text("u1", "user"),
    tool("t1"),
    tool("t2"),
    text("a1"),
    tool("t3"),
  ];

  it("show → one single per message", () => {
    const groups = groupMessages(messages, "show");
    expect(groups).toHaveLength(messages.length);
    expect(groups.every((g) => g.type === "single")).toBe(true);
  });

  it("hide → drops tool-card messages entirely", () => {
    const groups = groupMessages(messages, "hide");
    expect(groups.flatMap(ids)).toEqual(["u1", "a1"]);
  });
});

describe("groupMessages — group-run (consecutive runs)", () => {
  it("folds runs of ≥2 consecutive completed cards; lone card stays single", () => {
    const groups = groupMessages(
      [text("u1", "user"), tool("t1"), tool("t2"), tool("t3"), text("a1"), tool("t4")],
      "group-run",
    );
    // u1 | [t1,t2,t3] | a1 | t4(lone)
    expect(kinds(groups)).toEqual(["single", "tool-group", "single", "single"]);
    expect(ids(groups[1])).toEqual(["t1", "t2", "t3"]);
    expect(groups[1].type === "tool-group" && groups[1].id).toBe("toolgroup-t1");
  });

  it("keeps a running card ungrouped after a completed run", () => {
    const groups = groupMessages(
      [tool("t1"), tool("t2"), tool("t3", { running: true })],
      "group-run",
    );
    expect(kinds(groups)).toEqual(["tool-group", "single"]);
  });
});

describe("groupMessages — group-turn (one cluster per turn)", () => {
  it("gathers all of a turn's completed cards into one cluster at the first slot", () => {
    const groups = groupMessages(
      [
        text("u1", "user"),
        text("a1"),
        tool("t1"),
        text("a2"),
        tool("t2"),
        text("a3"),
      ],
      "group-turn",
    );
    // u1 | a1 | [t1,t2] (at t1's slot) | a2 | a3
    expect(kinds(groups)).toEqual([
      "single",
      "single",
      "tool-group",
      "single",
      "single",
    ]);
    expect(ids(groups[2])).toEqual(["t1", "t2"]);
    expect(groups[2].type === "tool-group" && groups[2].id).toBe("toolgroup-t1");
    expect(groups.map(ids).flat()).toEqual(["u1", "a1", "t1", "t2", "a2", "a3"]);
  });

  it("makes a separate cluster per turn", () => {
    const groups = groupMessages(
      [text("u1", "user"), tool("t1"), tool("t2"), text("u2", "user"), tool("t3"), tool("t4")],
      "group-turn",
    );
    expect(kinds(groups)).toEqual(["single", "tool-group", "single", "tool-group"]);
    expect(ids(groups[1])).toEqual(["t1", "t2"]);
    expect(ids(groups[3])).toEqual(["t3", "t4"]);
  });

  it("leaves a turn with ≤1 completed card ungrouped", () => {
    const groups = groupMessages(
      [text("u1", "user"), text("a1"), tool("t1")],
      "group-turn",
    );
    expect(kinds(groups)).toEqual(["single", "single", "single"]);
  });

  it("keeps a running card visible alongside the cluster", () => {
    const groups = groupMessages(
      [text("u1", "user"), tool("t1"), tool("t2"), tool("t3", { running: true })],
      "group-turn",
    );
    // u1 | [t1,t2] | t3(running)
    expect(kinds(groups)).toEqual(["single", "tool-group", "single"]);
    expect(ids(groups[1])).toEqual(["t1", "t2"]);
  });
});

describe("groupMessages — group-block (whole turn folded)", () => {
  it("folds a completed tool-using turn into one block; the last turn stays expanded", () => {
    const groups = groupMessages(
      [
        text("u1", "user"),
        text("a1"),
        tool("t1"),
        tool("t2"),
        text("a2"),
        text("u2", "user"),
        text("a3"),
        tool("t3"),
      ],
      "group-block",
    );
    // u1 | block([a1,t1,t2,a2]) | u2 | a3 | t3 (last turn = singles)
    expect(kinds(groups)).toEqual([
      "single",
      "turn-block",
      "single",
      "single",
      "single",
    ]);
    expect(ids(groups[1])).toEqual(["a1", "t1", "t2", "a2"]);
    expect(groups[1].type === "turn-block" && groups[1].id).toBe("turnblock-a1");
  });

  it("does not block a turn that used no tools", () => {
    const groups = groupMessages(
      [text("u1", "user"), text("a1"), text("u2", "user"), text("a2"), tool("t1")],
      "group-block",
    );
    expect(kinds(groups)).toEqual(["single", "single", "single", "single", "single"]);
  });

  it("never folds a segment that still has a running tool card", () => {
    const groups = groupMessages(
      [
        text("u1", "user"),
        text("a1"),
        tool("t1"),
        tool("t2", { running: true }),
        text("u2", "user"),
        text("a2"),
        tool("t3"),
      ],
      "group-block",
    );
    // Live progress (t2 running) must stay visible — the first turn is NOT
    // folded despite having a tool card; only completed turns fold.
    expect(kinds(groups).filter((k) => k === "turn-block")).toHaveLength(0);
    expect(kinds(groups).every((k) => k === "single")).toBe(true);
  });

  it("blocks a leading segment that has no user message", () => {
    const groups = groupMessages(
      [text("a0"), tool("t0"), text("u1", "user"), text("a1"), tool("t1")],
      "group-block",
    );
    // block([a0,t0]) | u1 | a1 | t1 (last turn singles)
    expect(kinds(groups)).toEqual(["turn-block", "single", "single", "single"]);
    expect(ids(groups[0])).toEqual(["a0", "t0"]);
  });
});

describe("groupKey", () => {
  it("keys singles by message id and clusters/blocks by group id", () => {
    expect(groupKey({ type: "single", message: text("m1") })).toBe("m1");
    expect(
      groupKey({ type: "tool-group", id: "toolgroup-x", messages: [tool("x")] }),
    ).toBe("toolgroup-x");
    expect(
      groupKey({ type: "turn-block", id: "turnblock-y", messages: [text("y")] }),
    ).toBe("turnblock-y");
  });
});

describe("anchorMessageIdForGroup", () => {
  it("returns the message id for a single", () => {
    expect(anchorMessageIdForGroup({ type: "single", message: text("m1") })).toBe(
      "m1",
    );
  });

  it("returns the first contained message id for clusters and blocks", () => {
    expect(
      anchorMessageIdForGroup({
        type: "tool-group",
        id: "toolgroup-a",
        messages: [tool("a"), tool("b")],
      }),
    ).toBe("a");
    expect(
      anchorMessageIdForGroup({
        type: "turn-block",
        id: "turnblock-c",
        messages: [text("c"), tool("d")],
      }),
    ).toBe("c");
  });

  it("is undefined-safe", () => {
    expect(anchorMessageIdForGroup(undefined)).toBeUndefined();
  });
});

describe("findGroupIndexForMessageId", () => {
  it("finds a message rendered as a single", () => {
    const groups = groupMessages([text("a"), text("b"), text("c")], "show");
    expect(findGroupIndexForMessageId(groups, "b")).toBe(1);
  });

  it("finds a message that folded into a cluster", () => {
    // group-run folds the two consecutive completed tool cards into one cluster.
    const groups = groupMessages(
      [text("u", "user"), tool("t0"), tool("t1"), text("done")],
      "group-run",
    );
    // groups: [single u, tool-group(t0,t1), single done]
    expect(groups[1].type).toBe("tool-group");
    expect(findGroupIndexForMessageId(groups, "t1")).toBe(1);
  });

  it("returns -1 when the id is absent (e.g. a hidden tool card) or undefined", () => {
    const groups = groupMessages([text("a"), tool("t0")], "hide");
    expect(findGroupIndexForMessageId(groups, "t0")).toBe(-1);
    expect(findGroupIndexForMessageId(groups, undefined)).toBe(-1);
  });
});
