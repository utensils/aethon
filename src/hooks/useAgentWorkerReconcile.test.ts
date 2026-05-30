import { describe, expect, it } from "vitest";
import { liveAgentTabIds } from "./useAgentWorkerReconcile";
import type { Tab } from "../types/tab";

function tab(id: string, kind: Tab["kind"]): Tab {
  return { id, kind, label: id, messages: [] } as Tab;
}

describe("liveAgentTabIds", () => {
  it("keeps only agent tabs", () => {
    const tabs = [
      tab("a1", "agent"),
      tab("s1", "shell"),
      tab("e1", "editor"),
      tab("a2", "agent"),
    ];
    expect(liveAgentTabIds(tabs)).toEqual(["a1", "a2"]);
  });

  it("returns an empty list when there are no agent tabs", () => {
    expect(liveAgentTabIds([tab("s1", "shell")])).toEqual([]);
    expect(liveAgentTabIds([])).toEqual([]);
  });
});
