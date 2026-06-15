import { describe, expect, it } from "vitest";
import { handleModelChanged } from "./modelChanged";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleModelChanged", () => {
  it("updates the tab and refreshes the picker for the active tab", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        sidebar: {
          models: [
            {
              id: "claude",
              label: "Claude",
              thinkingLevels: ["off", "medium"],
            },
            { id: "gpt", label: "GPT", codexFastModeSupported: true },
          ],
        },
      },
    });
    handleModelChanged(
      {
        type: "model_changed",
        tabId: "default",
        model: "gpt",
      },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("default");
    expect(updater(makeEmptyTab("default", "Tab 1")).model).toBe("gpt");
    expect(mocks.recordProjectModel).toHaveBeenCalledWith("gpt", "default");
    const next = applySetState();
    expect(next.status).toBe("switched to gpt");
    expect(
      (next.sidebar as { models: { id: string; active: boolean }[] }).models,
    ).toEqual([
      {
        id: "claude",
        label: "Claude",
        thinkingLevels: ["off", "medium"],
        active: false,
      },
      { id: "gpt", label: "GPT", codexFastModeSupported: true, active: true },
    ]);
  });

  it("does not record project model memory for global Fast-mode changes", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "default",
        codexFastMode: false,
        sidebar: { models: [{ id: "gpt", label: "GPT" }] },
      },
    });

    handleModelChanged(
      {
        type: "codex_fast_mode_changed",
        tabId: "default",
        model: "gpt",
        codexFastMode: true,
      },
      ctx,
    );

    expect(mocks.recordProjectModel).not.toHaveBeenCalled();
    const next = applySetState();
    expect(next.codexFastMode).toBe(true);
    expect(next.status).toBe("Codex Fast mode enabled");
  });

  it("leaves the picker untouched when a non-active tab changes model", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleModelChanged(
      { type: "model_changed", tabId: "tab-2", model: "gpt" },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
