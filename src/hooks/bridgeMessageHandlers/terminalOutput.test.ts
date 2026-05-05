// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flushTerminalOutput, handleTerminalOutput } from "./terminalOutput";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleTerminalOutput", () => {
  it("appends to the per-tab buffer, mirrors into state, and dispatches events", () => {
    const tabId = "default";
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: { activeTabId: tabId, terminal: { buffer: {} } },
    });
    const tap: { tabId: string; content: string }[] = [];
    const live: string[] = [];
    const onTap = (e: Event) => tap.push((e as CustomEvent).detail);
    const onLive = (e: Event) => live.push((e as CustomEvent).detail);
    window.addEventListener("aethon:terminal-tap", onTap);
    window.addEventListener("aethon:terminal", onLive);
    try {
      handleTerminalOutput(
        { type: "terminal_output", content: "abc", tabId },
        ctx,
      );
    } finally {
      window.removeEventListener("aethon:terminal-tap", onTap);
      window.removeEventListener("aethon:terminal", onLive);
    }
    flushTerminalOutput(tabId);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = { ...makeEmptyTab(tabId, "Tab 1"), terminalBuffer: "" };
    expect(updater(seed).terminalBuffer).toBe("abc");
    const next = applySetState();
    expect((next.terminal as { buffer: Record<string, string> }).buffer[tabId]).toBe(
      "abc",
    );
    expect(tap).toEqual([{ tabId, content: "abc" }]);
    expect(live).toEqual(["abc"]);
  });

  it("ignores empty content", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleTerminalOutput({ type: "terminal_output", content: "" }, ctx);
    expect(mocks.updateTab).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it("coalesces scrollback mirror writes while preserving live events", () => {
    const tabId = "default";
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: tabId, terminal: { buffer: {} } },
    });
    const live: string[] = [];
    const onLive = (e: Event) => live.push((e as CustomEvent).detail);
    window.addEventListener("aethon:terminal", onLive);
    try {
      handleTerminalOutput({ type: "terminal_output", content: "a", tabId }, ctx);
      handleTerminalOutput({ type: "terminal_output", content: "b", tabId }, ctx);
    } finally {
      window.removeEventListener("aethon:terminal", onLive);
    }
    expect(live).toEqual(["a", "b"]);
    expect(mocks.updateTab).not.toHaveBeenCalled();

    flushTerminalOutput(tabId);
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = { ...makeEmptyTab(tabId, "Tab 1"), terminalBuffer: "" };
    expect(updater(seed).terminalBuffer).toBe("ab");
  });
});
