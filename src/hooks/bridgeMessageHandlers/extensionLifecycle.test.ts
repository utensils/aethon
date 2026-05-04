// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { handleExtensionLifecycle } from "./extensionLifecycle";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionLifecycle", () => {
  it("dispatches a window event and appends a system message by default", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const seen: CustomEvent[] = [];
    const listener = (e: Event) => seen.push(e as CustomEvent);
    window.addEventListener("aethon:extension-lifecycle", listener);
    try {
      handleExtensionLifecycle(
        {
          type: "extension_lifecycle",
          name: "ext-foo",
          source: "directory",
          status: "loaded",
          tabId: "default",
        },
        ctx,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].detail.name).toBe("ext-foo");
      expect(mocks.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "system",
          text: expect.stringContaining("`ext-foo` loaded"),
        }),
        "default",
      );
    } finally {
      window.removeEventListener("aethon:extension-lifecycle", listener);
    }
  });

  it("skips the system message when a listener calls preventDefault", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const listener = (e: Event) => e.preventDefault();
    window.addEventListener("aethon:extension-lifecycle", listener);
    try {
      handleExtensionLifecycle(
        { type: "extension_lifecycle", name: "x", status: "failed", error: "boom" },
        ctx,
      );
      expect(mocks.appendMessage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("aethon:extension-lifecycle", listener);
    }
  });
});
