import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args: { payload: string }) =>
  Promise.resolve(),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { payload: string }) => invoke(cmd, args),
}));

import { resolveAccountSwitchTarget, switchAccountForTab } from "./commands";
import type { Tab } from "../types/tab";

function agentTab(over: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    kind: "agent",
    title: "Tab",
    cwd: "/repo",
    model: "openai-codex/gpt-5.5",
    messages: [],
    ...over,
  } as Tab;
}

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

  it("carries the tab cwd + model on the worker apply so a respawned worker keeps its workspace and model", async () => {
    await switchAccountForTab("tab-worker", "p1", {
      cwd: "/repo/feature",
      model: "openai-codex/gpt-5.5",
    });
    const apply = payloads().find((p) => p.type === "auth_profile_apply");
    expect(apply?.cwd).toBe("/repo/feature");
    expect(apply?.model).toBe("openai-codex/gpt-5.5");
  });
});

describe("resolveAccountSwitchTarget", () => {
  it("maps a real agent tab to itself with its cwd + model", () => {
    const tabs = [agentTab({ id: "t-real", cwd: "/x", model: "openai-codex/m" })];
    expect(resolveAccountSwitchTarget(tabs, "t-real")).toEqual({
      tabId: "t-real",
      cwd: "/x",
      model: "openai-codex/m",
      busy: false,
    });
  });

  it("falls back to the default (global) path for the overview pseudo-tab", () => {
    // The overview id is not a real session — switching it must not spawn a
    // worker, so it collapses to the default account path.
    expect(resolveAccountSwitchTarget([], "__overview__")).toEqual({
      tabId: "default",
      busy: false,
    });
  });

  it("falls back to default when the active tab id has no matching agent tab", () => {
    expect(resolveAccountSwitchTarget([agentTab()], "missing")).toEqual({
      tabId: "default",
      busy: false,
    });
  });

  it("reports busy for a tab that is mid-prompt", () => {
    const target = resolveAccountSwitchTarget(
      [agentTab({ id: "t-busy", waiting: true })],
      "t-busy",
    );
    expect(target.busy).toBe(true);
  });
});
