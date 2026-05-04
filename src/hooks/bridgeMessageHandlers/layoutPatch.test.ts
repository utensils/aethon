import { describe, expect, it } from "vitest";
import { handleLayoutPatch } from "./layoutPatch";
import { buildHandlerFixture } from "./testFixtures";

describe("handleLayoutPatch", () => {
  it("acks failure when path is missing", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleLayoutPatch(
      { type: "layout_patch", value: 1, mutationId: "m0" },
      ctx,
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith("m0", false, "missing path");
    expect(mocks.setLayout).not.toHaveBeenCalled();
  });

  it("calls setLayout with a reducer applying the patch and acks", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleLayoutPatch(
      {
        type: "layout_patch",
        path: "/components/0/text",
        value: "hello",
        mutationId: "m1",
      },
      ctx,
    );
    expect(mocks.setLayout).toHaveBeenCalledTimes(1);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
  });
});
