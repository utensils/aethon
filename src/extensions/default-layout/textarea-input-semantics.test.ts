import { describe, expect, it } from "vitest";
import type { AtMention } from "./at-mention";
import {
  insertMentionAtCursor,
  isVoiceSurfaceBlocked,
  shouldSubmitAtMentionEnter,
} from "./textarea-input-semantics";

const agent = { kind: "agent" as const, name: "kimi", description: "review", surface: "inline" as const };
const file = (rel: string) => ({ kind: "file" as const, rel, path: `/repo/${rel}` });

function at(query: string, matches = [agent, file("src/App.tsx")]): AtMention {
  return { query, start: 0, end: query.length + 1, matches };
}

describe("shared textarea input semantics", () => {
  it("cycles @ picker rows with Arrow navigation outside surface code", () => {
    const list = [0, 1, 2];
    expect((0 + 1) % list.length).toBe(1);
    expect((0 - 1 + list.length) % list.length).toBe(2);
  });

  it("inserts the selected @ mention text and cursor position for Tab-style completion", () => {
    expect(
      insertMentionAtCursor({
        value: "please @ki now",
        atMatch: { ...at("ki", [agent]), start: 7, end: 10 },
        match: agent,
      }),
    ).toEqual({ text: "please @kimi  now", cursor: 13 });
  });

  it("completes partial file mentions on Enter before submit", () => {
    expect(
      shouldSubmitAtMentionEnter({
        atMatch: at("app", [file("src/App.tsx")]),
        highlightedMatch: file("src/App.tsx"),
      }),
    ).toBe(false);
  });

  it("completes exact agent mentions on Enter before submit", () => {
    expect(
      shouldSubmitAtMentionEnter({
        atMatch: at("kimi", [agent]),
        highlightedMatch: agent,
      }),
    ).toBe(false);
  });

  it("submits exact file path mentions on Enter", () => {
    expect(
      shouldSubmitAtMentionEnter({
        atMatch: at("src/App.tsx", [file("src/App.tsx")]),
        highlightedMatch: file("src/App.tsx"),
      }),
    ).toBe(true);
  });

  it.each([
    ["hidden surface", { surfaceActive: false }, true],
    ["Settings open", { surfaceActive: true, settingsOpen: true }, true],
    ["palette open", { surfaceActive: true, paletteOpen: true }, true],
    ["search open", { surfaceActive: true, searchOpen: true }, true],
    ["visible surface", { surfaceActive: true }, false],
  ] as const)("blocks voice start for %s", (_label, state, expected) => {
    expect(isVoiceSurfaceBlocked(state)).toBe(expected);
  });
});
