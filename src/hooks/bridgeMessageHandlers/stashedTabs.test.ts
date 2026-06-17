// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { makeEmptyTab, type Tab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";
import type { TabBucket } from "../projectOps/types";
import { updateTabAcrossBuckets } from "../tabRouting";
import { handleA2ui } from "./a2ui";
import { handlePromptStarted } from "./promptStarted";
import { handleResponseDelta, flushResponseDeltas } from "./responseDelta";
import { handleResponseEnd } from "./responseEnd";
import { buildHandlerFixture } from "./testFixtures";

function bucketTab(bucket: TabBucket): Tab {
  const tab = bucket.tabs[0];
  if (!tab) throw new Error("missing bucket tab");
  return tab;
}

describe("bridge handlers for stashed tabs", () => {
  it("routes prompt, text, a2ui, and completion updates into hidden buckets", () => {
    const hidden = {
      ...makeEmptyTab("hidden", "Hidden", "p2", "agent"),
      cwd: "/repo/other-work",
    };
    const tabBucketsRef = {
      current: new Map<string, TabBucket>([
        ["p2::workspace::wt-2", { tabs: [hidden], activeTabId: "hidden" }],
      ]),
    };
    const { ctx } = buildHandlerFixture({
      state: {
        activeTabId: "main",
        tabs: [makeEmptyTab("main", "Main", "p1", "agent")],
        persistedTabBuckets: {
          "p2::workspace::wt-2": { tabs: [hidden], activeTabId: "hidden" },
        },
      },
    });
    ctx.projectsRef.current = {
      activeId: "p1",
      activeWorkspaceId: null,
      activeHostId: null,
      projects: [
        { id: "p1", label: "Main", path: "/repo/main", lastUsed: 1 },
        { id: "p2", label: "Other", path: "/repo/other", lastUsed: 2 },
      ],
      workspacesByProject: {
        p2: [
          {
            id: "wt-2",
            projectId: "p2",
            path: "/repo/other-work",
            branch: "feat/other",
            isMain: false,
          },
        ],
      },
    };
    ctx.updateTab = (tabId, mutator) =>
      updateTabAcrossBuckets(
        {
          setState: ctx.setState,
          stateRef: ctx.stateRef,
          projectsRef: ctx.projectsRef,
          tabBucketsRef,
        },
        tabId,
        mutator,
      );
    ctx.appendOrAmendAgentText = (
      delta: string,
      messageId?: string,
      tabId = "default",
    ) => {
      ctx.updateTab(tabId, (tab) => {
        const messages = tab.messages.slice();
        const id = messageId ?? "legacy";
        const idx = messages.findIndex((message) => message.id === id);
        const next: ChatMessage =
          idx >= 0
            ? { ...messages[idx], text: `${messages[idx].text ?? ""}${delta}` }
            : { id, role: "agent", text: delta };
        if (idx >= 0) messages[idx] = next;
        else messages.push(next);
        return { ...tab, messages };
      });
    };
    ctx.appendMessage = (message, tabId = "default") => {
      ctx.updateTab(tabId, (tab) => ({
        ...tab,
        messages: [...tab.messages, message],
      }));
    };

    handlePromptStarted({ type: "prompt_started", tabId: "hidden" }, ctx);
    expect(bucketTab(tabBucketsRef.current.get("p2::workspace::wt-2")!).waiting)
      .toBe(true);
    expect(ctx.stateRef.current.agentRunningTabs).toEqual({ hidden: true });

    handleResponseDelta(
      {
        type: "response_delta",
        tabId: "hidden",
        messageId: "msg-1",
        content: "hello",
      },
      ctx,
    );
    flushResponseDeltas("hidden");
    expect(
      bucketTab(tabBucketsRef.current.get("p2::workspace::wt-2")!).messages,
    ).toEqual([expect.objectContaining({ id: "msg-1", text: "hello" })]);

    const payload = { components: [{ id: "tool-1", type: "tool-card" }] };
    handleA2ui(
      { type: "a2ui", tabId: "hidden", id: "tool-1", payload },
      ctx,
    );
    expect(
      bucketTab(tabBucketsRef.current.get("p2::workspace::wt-2")!).messages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool-1", a2ui: payload }),
      ]),
    );

    handleResponseEnd({ type: "response_end", tabId: "hidden" }, ctx);
    expect(bucketTab(tabBucketsRef.current.get("p2::workspace::wt-2")!).waiting)
      .toBe(false);
    expect(ctx.stateRef.current.agentRunningTabs).toEqual({});
    expect(
      (
        ctx.stateRef.current.persistedTabBuckets as Record<string, TabBucket>
      )["p2::workspace::wt-2"].tabs[0]?.waiting,
    ).toBe(false);
  });
});
