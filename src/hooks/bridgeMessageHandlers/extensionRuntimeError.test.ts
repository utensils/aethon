import { describe, expect, it } from "vitest";
import { handleExtensionRuntimeError } from "./extensionRuntimeError";
import { buildHandlerFixture } from "./testFixtures";

describe("handleExtensionRuntimeError", () => {
  it("pushes a sticky warning notification keyed by extension name", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleExtensionRuntimeError(
      {
        type: "extension_runtime_error",
        name: "ext-bad",
        kind: "state-too-large",
        path: "/foo",
        sizeKB: 65,
        limitKB: 16,
      },
      ctx,
    );
    expect(mocks.pushNotification).toHaveBeenCalledWith({
      id: "ext-runtime-error:ext-bad",
      title: "Extension `ext-bad` is misbehaving",
      message:
        "setState /foo rejected — 65 KB exceeds 16 KB limit. Store file paths, not content.",
      kind: "warning",
      durationMs: null,
    });
  });
});
