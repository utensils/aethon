import { describe, expect, it } from "vitest";
import {
  MAX_A2UI_BYTES,
  MAX_TEXT_BYTES,
  coerceChatMessages,
  stripImageDataUrls,
  trimMessage,
  truncateToEntry,
} from "./messages";
import type { ChatMessage } from "../types/a2ui";

describe("truncateToEntry", () => {
  const messages: ChatMessage[] = [
    { id: "1", entryId: "e1", role: "user", text: "a" },
    { id: "2", entryId: "e2", role: "agent", text: "b" },
    { id: "3", entryId: "e3", role: "user", text: "c" },
  ];

  it("keeps the prefix up to and including the matched entry", () => {
    expect(truncateToEntry(messages, "e2").map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("returns the same array reference when no entry matches", () => {
    expect(truncateToEntry(messages, "missing")).toBe(messages);
  });

  it("keeps everything when the last entry matches", () => {
    expect(truncateToEntry(messages, "e3")).toHaveLength(3);
  });
});

describe("stripImageDataUrls", () => {
  it("returns non-objects unchanged", () => {
    expect(stripImageDataUrls(null)).toBeNull();
    expect(stripImageDataUrls("foo")).toBe("foo");
    expect(stripImageDataUrls(7)).toBe(7);
  });

  it("replaces a top-level image data URL with a caption placeholder", () => {
    const out = stripImageDataUrls({
      type: "image",
      props: { src: "data:image/png;base64,AAA", alt: "ok" },
    }) as { props: Record<string, string> };
    expect(out.props.src).toBe("");
    expect(out.props.caption).toBe("[image dropped from history]");
    expect(out.props.alt).toBe("ok");
  });

  it("leaves non-data image src alone", () => {
    const out = stripImageDataUrls({
      type: "image",
      props: { src: "https://example.com/x.png" },
    }) as { props: { src: string; caption?: string } };
    expect(out.props.src).toBe("https://example.com/x.png");
    expect(out.props.caption).toBeUndefined();
  });

  it("recurses into children arrays", () => {
    const out = stripImageDataUrls({
      type: "container",
      children: [
        { type: "image", props: { src: "data:image/png;base64,B" } },
        { type: "text", props: { value: "ok" } },
      ],
    }) as {
      children: Array<{ type: string; props: Record<string, unknown> }>;
    };
    expect(out.children[0].props.src).toBe("");
    expect(out.children[1].props.value).toBe("ok");
  });
});

describe("trimMessage", () => {
  it("truncates text past MAX_TEXT_BYTES with an ellipsis", () => {
    const long = "x".repeat(MAX_TEXT_BYTES + 100);
    const out = trimMessage({ id: "1", role: "user", text: long });
    expect(out.text!.length).toBe(MAX_TEXT_BYTES);
    expect(out.text!.endsWith("…")).toBe(true);
  });

  it("leaves short text alone", () => {
    const out = trimMessage({ id: "1", role: "user", text: "ok" });
    expect(out.text).toBe("ok");
  });

  it("strips data URLs from a2ui components", () => {
    const out = trimMessage({
      id: "1",
      role: "agent",
      a2ui: {
        components: [
          { type: "image", props: { src: "data:image/png;base64,AAA" } },
        ],
        rootId: "image",
      } as never,
    });
    const comps = out.a2ui!.components as unknown as Array<{
      props: { src: string };
    }>;
    expect(comps[0].props.src).toBe("");
  });

  it("falls back to lightweight a2ui summaries when payloads exceed the durable budget", () => {
    const out = trimMessage({
      id: "1",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-1-call-1",
            type: "tool-card",
            props: {
              title: "bash",
              toolName: "bash",
              description: "nix flake check",
              startedAt: 1,
            },
            children: Array.from({ length: 16 }, (_, index) => ({
              id: `tool-1-call-1-result-${index}`,
              type: "code",
              props: { content: "x".repeat(MAX_A2UI_BYTES * 2) },
            })),
          },
        ],
      },
    });

    expect(JSON.stringify(out.a2ui).length).toBeLessThan(MAX_A2UI_BYTES);
    expect(out.a2ui?.components[0]).toMatchObject({
      id: "tool-1-call-1",
      type: "tool-card",
      props: {
        title: "bash",
        toolName: "bash",
        description: "nix flake check",
        startedAt: 1,
      },
      children: [],
    });
  });
});

describe("coerceChatMessages", () => {
  it("returns empty for non-arrays", () => {
    expect(coerceChatMessages(null)).toEqual([]);
    expect(coerceChatMessages("nope")).toEqual([]);
    expect(coerceChatMessages({})).toEqual([]);
  });

  it("filters out items missing a role", () => {
    expect(coerceChatMessages([{ text: "no role" }])).toEqual([]);
  });

  it("filters out items missing both text and a2ui", () => {
    expect(coerceChatMessages([{ role: "user" }])).toEqual([]);
  });

  it("preserves a string id when present", () => {
    const out = coerceChatMessages([{ id: "abc", role: "user", text: "hi" }]);
    expect(out[0].id).toBe("abc");
  });

  it("threads the pi entry id when present", () => {
    const out = coerceChatMessages([
      { id: "abc", entryId: "e1f2", role: "user", text: "hi" },
    ]);
    expect(out[0].entryId).toBe("e1f2");
  });

  it("omits entryId when absent", () => {
    const out = coerceChatMessages([{ id: "abc", role: "user", text: "hi" }]);
    expect(out[0].entryId).toBeUndefined();
  });

  it("preserves finite creation timestamps", () => {
    const out = coerceChatMessages([
      { id: "abc", role: "system", text: "warning", createdAt: 1_234 },
    ]);
    expect(out[0]).toEqual({
      id: "abc",
      role: "system",
      text: "warning",
      createdAt: 1_234,
    });
  });

  it("generates a uuid when id missing", () => {
    const out = coerceChatMessages([{ role: "user", text: "hi" }]);
    expect(out[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("accepts a2ui-only messages", () => {
    const out = coerceChatMessages([
      { role: "agent", a2ui: { components: [] } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].a2ui).toBeDefined();
  });

  it("preserves thinking-only messages", () => {
    const out = coerceChatMessages([
      { id: "t1", role: "agent", thinking: "working it out" },
    ]);
    expect(out).toEqual([
      { id: "t1", role: "agent", thinking: "working it out" },
    ]);
  });

  it("collapses repeated amended agent snapshots by id", () => {
    const out = coerceChatMessages([
      { id: "t1", role: "agent", thinking: "first", createdAt: 10 },
      { id: "t1", role: "agent", thinking: "first second", createdAt: 20 },
      { id: "u1", role: "user", text: "next" },
      { id: "t1", role: "agent", text: "final", createdAt: 30 },
    ]);

    expect(out).toEqual([
      {
        id: "t1",
        role: "agent",
        thinking: "first second",
        text: "final",
        createdAt: 10,
      },
      { id: "u1", role: "user", text: "next" },
    ]);
  });

  it("does not let empty amended snapshots erase prior streamed content", () => {
    const out = coerceChatMessages([
      { id: "t1", role: "agent", text: "visible", thinking: "plan" },
      { id: "t1", role: "agent", text: "", thinking: "" },
    ]);

    expect(out).toEqual([
      { id: "t1", role: "agent", text: "visible", thinking: "plan" },
    ]);
  });

  it("preserves known user delivery states", () => {
    const out = coerceChatMessages([
      { id: "q1", role: "user", text: "after this", delivery: "queued" },
      { id: "s1", role: "user", text: "look now", delivery: "steered" },
      { id: "x1", role: "user", text: "nope", delivery: "bogus" },
    ]);
    expect(out).toEqual([
      { id: "q1", role: "user", text: "after this", delivery: "queued" },
      { id: "s1", role: "user", text: "look now", delivery: "steered" },
      { id: "x1", role: "user", text: "nope" },
    ]);
  });

  it("rejects unknown roles", () => {
    expect(coerceChatMessages([{ role: "supervisor", text: "x" }])).toEqual([]);
  });
});
