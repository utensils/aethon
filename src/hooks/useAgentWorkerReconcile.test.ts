import { describe, expect, it } from "vitest";
import { liveAgentTabIds } from "./useAgentWorkerReconcile";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";

function tab(id: string, kind: Tab["kind"]): Tab {
  return { id, kind, label: id, messages: [] } as Tab;
}

function bucket(tabs: Tab[]): TabBucket {
  return { tabs, activeTabId: tabs[0]?.id };
}

describe("liveAgentTabIds", () => {
  it("keeps only agent tabs from the active bucket", () => {
    const tabs = [
      tab("a1", "agent"),
      tab("s1", "shell"),
      tab("e1", "editor"),
      tab("a2", "agent"),
    ];
    expect(liveAgentTabIds(tabs, [])).toEqual(["a1", "a2"]);
  });

  it("unions agent tabs across inactive project buckets", () => {
    const active = [tab("a1", "agent")];
    const buckets = [
      bucket([tab("b1", "agent"), tab("bshell", "shell")]),
      bucket([tab("b2", "agent")]),
    ];
    expect(liveAgentTabIds(active, buckets).sort()).toEqual(["a1", "b1", "b2"]);
  });

  it("dedupes a tab present in both the active list and a stale bucket", () => {
    const active = [tab("a1", "agent")];
    const buckets = [bucket([tab("a1", "agent"), tab("b1", "agent")])];
    expect(liveAgentTabIds(active, buckets).sort()).toEqual(["a1", "b1"]);
  });

  it("returns an empty list when there are no agent tabs", () => {
    expect(liveAgentTabIds([tab("s1", "shell")], [])).toEqual([]);
    expect(liveAgentTabIds([], [])).toEqual([]);
  });
});
