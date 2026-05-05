import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleReloadRequired } from "./reloadRequired";
import { buildHandlerFixture } from "./testFixtures";
import { clearTauriMocks, installTauriMocks } from "../../test/tauriMocks";

describe("handleReloadRequired", () => {
  let harness: ReturnType<typeof installTauriMocks>;
  beforeEach(() => {
    harness = installTauriMocks();
  });
  afterEach(() => {
    clearTauriMocks();
  });

  it("invokes reload_agent (which emits agent-reloaded → useOsEdges respawns)", async () => {
    const { ctx } = buildHandlerFixture();
    harness.invoke.mockResolvedValue(undefined);
    handleReloadRequired(
      { type: "reload_required", reason: "extension-toggle:x" },
      ctx,
    );
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledWith("reload_agent");
  });
});
