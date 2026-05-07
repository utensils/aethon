import { describe, expect, it } from "vitest";
import { handleNativeSlashResult } from "./nativeSlashResult";
import { buildHandlerFixture } from "./testFixtures";

describe("handleNativeSlashResult", () => {
  it("appends successful native command output as a system message", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNativeSlashResult(
      {
        type: "native_slash_result",
        command: "context",
        tabId: "tab-1",
        message: "## Context\n- Used: 1,234 tokens",
      },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "## Context\n- Used: 1,234 tokens",
      }),
      "tab-1",
    );
    expect(mocks.persistLocalChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "## Context\n- Used: 1,234 tokens",
      }),
      "tab-1",
    );
    expect(mocks.pushNotification).not.toHaveBeenCalled();
  });

  it("also raises an error toast for failed native commands", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleNativeSlashResult(
      {
        type: "native_slash_result",
        command: "compact",
        kind: "error",
        message: "Compaction failed: Nothing to compact",
      },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "Compaction failed: Nothing to compact",
      }),
      "default",
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      title: "/compact failed",
      message: "Compaction failed: Nothing to compact",
      kind: "error",
    });
  });
});
