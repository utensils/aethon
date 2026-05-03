import { describe, expect, it } from "vitest";
import { canDeleteHistoryItem, extractSessionId } from "./sidebarHistory";

describe("extractSessionId", () => {
  it("strips session: prefix", () => {
    expect(extractSessionId("session:abc-123")).toBe("abc-123");
  });

  it("strips tab: prefix — open agent tabs share the delete flow", () => {
    expect(extractSessionId("tab:abc-123")).toBe("abc-123");
  });

  it("returns the input unchanged when no known prefix is present", () => {
    expect(extractSessionId("abc-123")).toBe("abc-123");
  });

  it("does not double-strip — a session:tab:foo id keeps the inner literal", () => {
    expect(extractSessionId("session:tab:foo")).toBe("tab:foo");
  });
});

describe("canDeleteHistoryItem", () => {
  it("accepts session: ids", () => {
    expect(canDeleteHistoryItem("session:x")).toBe(true);
  });

  it("accepts tab: ids — fixes the WebKit context-menu falling through", () => {
    // Before this fix, right-clicking an open tab in the chat-history
    // section showed Reload / Inspect Element instead of the Delete
    // action, because the openItemContextMenu handler only triggered
    // for `session:` ids and bailed for `tab:` ids — so e.preventDefault
    // never ran.
    expect(canDeleteHistoryItem("tab:x")).toBe(true);
  });

  it("rejects unknown prefixes so we don't show no-op actions", () => {
    expect(canDeleteHistoryItem("project:x")).toBe(false);
    expect(canDeleteHistoryItem("naked-id")).toBe(false);
    expect(canDeleteHistoryItem("")).toBe(false);
  });
});
