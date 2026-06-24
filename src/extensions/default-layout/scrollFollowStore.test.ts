import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/a2ui";
import { buildTranscriptRows } from "../../utils/transcriptRows";
import {
  createTabScrollAnchorStore,
  dropStaleRestoreAnchor,
  initialIndexForRestoreAnchor,
  updateAnchorFromRange,
  updateAnchorFromUserScroll,
} from "./scrollFollowStore";

const messages: ChatMessage[] = [
  { id: "m0", role: "user", text: "zero" },
  { id: "m1", role: "agent", text: "one" },
  { id: "m2", role: "user", text: "two" },
];
const rows = buildTranscriptRows(messages, "show", new Set()).rows;

describe("scrollFollowStore", () => {
  it("stores anchors only while not following and maps restore indexes", () => {
    const store = createTabScrollAnchorStore();

    updateAnchorFromRange({
      following: true,
      range: { startIndex: 1, endIndex: 2 },
      rows,
      store,
      tabId: "tab",
    });
    expect(store.get("tab")).toBeUndefined();

    updateAnchorFromRange({
      following: false,
      range: { startIndex: 1, endIndex: 2 },
      rows,
      store,
      tabId: "tab",
    });
    expect(store.get("tab")).toBe("m2");
    expect(
      initialIndexForRestoreAnchor({ rows, restoreAnchorId: "m2" })
        .initialTopMostItemIndex,
    ).toEqual({ index: 1, align: "start" });
  });

  it("deletes cached anchors when a genuine user scroll reaches bottom", () => {
    const store = createTabScrollAnchorStore();
    store.set("tab", "m1");

    updateAnchorFromUserScroll({
      atBottom: true,
      range: { startIndex: 1, endIndex: 2 },
      rows,
      store,
      tabId: "tab",
    });

    expect(store.get("tab")).toBeUndefined();
  });

  it("drops stale restore anchors and reports whether it deleted one", () => {
    const store = createTabScrollAnchorStore();
    store.set("tab", "missing");

    expect(
      dropStaleRestoreAnchor({
        restoreAnchorId: "missing",
        restoreIndex: -1,
        store,
        tabId: "tab",
      }),
    ).toBe(true);
    expect(store.get("tab")).toBeUndefined();
  });
});
