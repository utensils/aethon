import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args: { payload: string }) =>
  Promise.resolve(),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { payload: string }) => invoke(cmd, args),
}));

import { switchAccountForTab } from "./commands";

function payloads(): Array<Record<string, unknown>> {
  return invoke.mock.calls.map(
    (call) => JSON.parse(call[1].payload) as Record<string, unknown>,
  );
}

describe("switchAccountForTab", () => {
  beforeEach(() => invoke.mockClear());

  it("relays both use_for_tab and apply for a non-default (worker) tab", async () => {
    await switchAccountForTab("tab-worker", "openai-codex-secondary");
    const types = payloads().map((p) => p.type);
    // The worker bridge must also re-auth, or it keeps the old account.
    expect(types).toEqual([
      "auth_profile_use_for_tab",
      "auth_profile_apply",
    ]);
    for (const p of payloads()) {
      expect(p.tabId).toBe("tab-worker");
      expect(p.profileId).toBe("openai-codex-secondary");
    }
  });

  it("only sends use_for_tab for the default tab (global bridge owns it)", async () => {
    await switchAccountForTab("default", "openai-codex-primary");
    expect(payloads().map((p) => p.type)).toEqual(["auth_profile_use_for_tab"]);
  });
});
