import { describe, expect, it } from "vitest";
import { handleSessionHistory } from "./sessionHistory";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

describe("handleSessionHistory", () => {
  it("replaces the tab's messages and triggers a recents resync", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          { id: "1", role: "user", text: "hi" },
          { id: "2", role: "agent", text: "hello" },
        ],
      },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.messages).toHaveLength(2);
    expect(mocks.syncRecentSessionsToState).toHaveBeenCalledTimes(1);
  });

  it("uses discovered custom session labels for restored chat tabs", () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.allDiscoveredSessionsRef.current = [
      {
        tabId: "tab-1",
        lastModified: 1,
        firstUserMessage: "first prompt",
        customLabel: "Named session",
      },
    ];
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [{ id: "1", role: "user", text: "hi" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.label).toBe("Named session");
  });

  it("derives generic restored tab labels from the first user message", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "default",
        messages: [
          {
            id: "1",
            role: "user",
            text: "Research this application and summarize the changes",
          },
          { id: "2", role: "agent", text: "Done." },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("default", "Tab 1"));
    expect(out.label).toBe(
      "Research this application and summarize the cha...",
    );
  });

  it("does not replace explicit tab labels with restored first messages", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "default",
        messages: [{ id: "1", role: "user", text: "first prompt" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("default", "Custom label"));
    expect(out.label).toBe("Custom label");
  });

  it("appends a pending launch prompt AFTER the restored transcript so order stays chronological", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [{ id: "agent-1", role: "agent", text: "Working" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      waiting: true,
      messages: [
        {
          id: "local-prompt",
          role: "user",
          text: "Fix issue 85",
          delivery: "sent",
        },
      ],
    });
    // Restored history first, in-flight local message after — the
    // bug the peer-review caught was the inverse: pending prompts
    // surfaced ABOVE older restored history, making the transcript
    // unreadable.
    expect(out.messages).toEqual([
      expect.objectContaining({ id: "agent-1", role: "agent" }),
      expect.objectContaining({
        id: "local-prompt",
        role: "user",
        text: "Fix issue 85",
      }),
    ]);
  });

  it("preserves in-flight assistant streaming deltas across the restore", () => {
    // Regression: the merge previously filtered to user messages only,
    // so an assistant bubble already streaming when session_history
    // arrived would vanish — the user would watch their answer get
    // wiped mid-response.
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          { id: "old-user", role: "user", text: "previous prompt" },
          { id: "old-agent", role: "agent", text: "previous answer" },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      waiting: true,
      messages: [
        {
          id: "local-prompt",
          role: "user",
          text: "what about this",
          delivery: "sent",
        },
        {
          id: "streaming-agent",
          role: "agent",
          text: "I'm thinki",
        },
      ],
    });
    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "old-agent",
      "local-prompt",
      "streaming-agent",
    ]);
    expect(out.waiting).toBe(true);
  });

  it("drops stale running tool cards when restored history has the completed tool result", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const toolCallId =
      "call_bBEjXjY3q5AY7nMBo0Ds8g3w|fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "restored-tool-call_bBEjXjY3q5AY7nMBo0Ds8g3w-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59",
            role: "agent",
            a2ui: {
              components: [
                {
                  id: "restored-tool-call_bBEjXjY3q5AY7nMBo0Ds8g3w-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59",
                  type: "tool-card",
                  props: {
                    title: "bash",
                    toolName: "bash",
                    description: "PR=$(gh pr view --json number -q .number)",
                    startedAt: 1_000,
                    endedAt: 2_000,
                  },
                  children: [
                    {
                      id: "result",
                      type: "code",
                      props: { content: "done" },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      waiting: true,
      messages: [
        {
          id: `tool-16-${toolCallId}`,
          role: "agent",
          a2ui: {
            components: [
              {
                id: `tool-16-${toolCallId}`,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "PR=$(gh pr view --json number -q .number)",
                  startedAt: 1_000,
                },
              },
            ],
          },
        },
      ],
    });

    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].id).toBe(
      "restored-tool-call_bBEjXjY3q5AY7nMBo0Ds8g3w-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59",
    );
    expect(out.waiting).toBe(false);
  });

  it("drops restored duplicate assistant text and completed tool cards so reloads do not look busy", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "restored-thinking",
            role: "agent",
            thinking: "Monitoring requests",
          },
          {
            id: "restored-tool-call_dupe",
            role: "agent",
            a2ui: {
              components: [
                {
                  id: "restored-tool-call_dupe",
                  type: "tool-card",
                  props: {
                    title: "bash",
                    toolName: "bash",
                    description: "gh pr view --json number",
                    startedAt: 1_000,
                    endedAt: 2_000,
                  },
                },
              ],
            },
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      waiting: true,
      messages: [
        {
          id: "local-thinking",
          role: "agent",
          thinking: "Monitoring requests",
        },
        {
          id: "tool-16-call_dupe",
          role: "agent",
          a2ui: {
            components: [
              {
                id: "tool-16-call_dupe",
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "gh pr view --json number",
                  startedAt: 1_000,
                  endedAt: 2_000,
                },
              },
            ],
          },
        },
      ],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "restored-thinking",
      "restored-tool-call_dupe",
    ]);
    expect(out.waiting).toBe(false);
  });

  it("drops failed local user messages on restore (they are informational once history arrives)", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [{ id: "old-user", role: "user", text: "fine" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      messages: [
        {
          id: "local-failed",
          role: "user",
          text: "lost in transit",
          delivery: "failed",
        },
      ],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: "old-user" });
  });

  it("does not duplicate a pending prompt already present in restored history", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [{ id: "restored-user", role: "user", text: "Fix issue 85" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      messages: [
        {
          id: "local-prompt",
          role: "user",
          text: "Fix issue 85",
          delivery: "sent",
        },
      ],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: "restored-user" });
  });
});
