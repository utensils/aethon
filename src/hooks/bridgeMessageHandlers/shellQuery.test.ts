import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleShellQuery } from "./shellQuery";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleShellQuery", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("routes list to shell_list_shareable and acks with data", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    harness.invoke.mockResolvedValueOnce(["tab-1", "tab-2"]);
    handleShellQuery(
      { type: "shell_query", op: "list", mutationId: "m1" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("shell_list_shareable");
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true, undefined, [
      "tab-1",
      "tab-2",
    ]);
  });

  it("acks failure for unknown ops", async () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleShellQuery(
      { type: "shell_query", op: "explode", mutationId: "m2" },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m2",
      false,
      "unknown shell_query op: explode",
    );
  });
});
