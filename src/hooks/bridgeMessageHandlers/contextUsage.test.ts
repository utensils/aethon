import { describe, expect, it } from "vitest";
import { makeEmptyTab } from "../../types/tab";
import { handleContextUsage } from "./contextUsage";
import { buildHandlerFixture } from "./testFixtures";

describe("handleContextUsage", () => {
  it("stores context usage on the target tab", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });

    handleContextUsage(
      {
        type: "context_usage",
        tabId: "default",
        model: "anthropic/claude",
        status: "known",
        tokens: 12_000,
        contextWindow: 200_000,
        percent: 6,
        autoCompactEnabled: true,
        reserveTokens: 16_384,
        compactAtTokens: 183_616,
        tokensUntilCompact: 171_616,
      },
      ctx,
    );

    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("default");
    expect(updater(makeEmptyTab("default", "Tab 1")).contextUsage).toEqual({
      tabId: "default",
      model: "anthropic/claude",
      status: "known",
      tokens: 12_000,
      contextWindow: 200_000,
      percent: 6,
      autoCompactEnabled: true,
      reserveTokens: 16_384,
      compactAtTokens: 183_616,
      tokensUntilCompact: 171_616,
    });
  });

  it("ignores malformed usage payloads", () => {
    const { ctx, mocks } = buildHandlerFixture();

    handleContextUsage(
      {
        type: "context_usage",
        tabId: "default",
        tokens: 12_000,
      },
      ctx,
    );

    expect(mocks.updateTab).not.toHaveBeenCalled();
  });
});
