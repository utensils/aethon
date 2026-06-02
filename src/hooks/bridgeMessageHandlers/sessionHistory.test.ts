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

  it("keeps restored image attachments on user messages", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "image-user",
            role: "user",
            text: "what is this?",
            attachments: [
              {
                id: "img-1",
                kind: "image",
                path: "/tmp/aethon-pastes/one.png",
                name: "one.png",
                mimeType: "image/png",
                sizeBytes: 12,
              },
            ],
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.messages).toEqual([
      {
        id: "image-user",
        role: "user",
        text: "what is this?",
        attachments: [
          {
            id: "img-1",
            kind: "image",
            path: "/tmp/aethon-pastes/one.png",
            name: "one.png",
            mimeType: "image/png",
            sizeBytes: 12,
          },
        ],
      },
    ]);
  });

  it("restores image-only messages", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "image-only",
            role: "user",
            attachments: [
              {
                id: "img-1",
                kind: "image",
                path: "/tmp/aethon-pastes/one.png",
                name: "one.png",
                mimeType: "image/png",
                sizeBytes: 12,
              },
            ],
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.messages[0]).toMatchObject({
      id: "image-only",
      role: "user",
      attachments: [
        expect.objectContaining({
          path: "/tmp/aethon-pastes/one.png",
        }),
      ],
    });
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

  it("does not append a persisted stderr mirror below restored history", () => {
    const { ctx, mocks } = buildHandlerFixture();
    const stderrText =
      "[agent stderr] 2026-06-02T13:36:55.343Z WARN devshell: env_for_path(/repo) failed: timeout tabId=tab-1";
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "restored-stderr",
            role: "system",
            text: stderrText,
            createdAt: 2_000,
          },
          {
            id: "old-agent",
            role: "agent",
            text: "previous answer",
            createdAt: 3_000,
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
          id: "local-stderr",
          role: "system",
          text: stderrText,
          createdAt: 2_000,
        },
        {
          id: "streaming-agent",
          role: "agent",
          text: "new answer is streaming",
        },
      ],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "restored-stderr",
      "old-agent",
      "streaming-agent",
    ]);
    expect(out.waiting).toBe(true);
  });

  it("orders timestamped local stderr by its original time during hydrate", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "old-agent",
            role: "agent",
            text: "previous answer",
            createdAt: 3_000,
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      messages: [
        {
          id: "local-stderr",
          role: "system",
          text: "[agent stderr] 2026-06-02T13:36:55.343Z WARN devshell: failed",
          createdAt: 2_000,
        },
        {
          id: "streaming-agent",
          role: "agent",
          text: "new answer is streaming",
        },
      ],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "local-stderr",
      "old-agent",
      "streaming-agent",
    ]);
  });

  it("orders stale local assistant snapshots by timestamp when the tab is idle", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "newer-agent",
            role: "agent",
            text: "newer restored answer",
            createdAt: 3_000,
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const tab = makeEmptyTab("tab-1", "Tab 1");
    const out = updater({
      ...tab,
      waiting: false,
      messages: [
        {
          id: "stale-stream",
          role: "agent",
          text: "old streamed answer",
          createdAt: 2_000,
        },
      ],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "stale-stream",
      "newer-agent",
    ]);
    expect(out.waiting).toBe(false);
  });

  it("clears active thinking status when hydration proves the tab is idle", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        activeTabId: "tab-1",
        waiting: true,
        status: "thinking…",
        tabs: [
          {
            ...makeEmptyTab("tab-1", "Tab 1"),
            waiting: true,
            messages: [
              {
                id: "stale-stream",
                role: "agent",
                text: "old streamed answer",
                createdAt: 2_000,
              },
            ],
          },
        ],
      },
    });
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "newer-agent",
            role: "agent",
            text: "newer restored answer",
            createdAt: 3_000,
          },
        ],
      },
      ctx,
    );

    expect(mocks.setStatusFlags).toHaveBeenCalledWith({
      waiting: false,
      status: "ready",
    });
  });

  it("does not restore durable stop notices as the latest chat message", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "stopped",
            role: "system",
            text: "Agent stopped.",
            createdAt: 2_000,
          },
          {
            id: "old-agent",
            role: "agent",
            text: "previous answer",
            createdAt: 3_000,
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "old-agent",
    ]);
  });

  it("does not append live compaction notices below restored compaction markers", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "old-user",
            role: "user",
            text: "previous prompt",
            createdAt: 1_000,
          },
          {
            id: "compaction:cmp-1",
            role: "system",
            text: "Context compacted · 13,005 tokens summarized",
            createdAt: 2_000,
          },
          {
            id: "old-agent",
            role: "agent",
            text: "previous answer",
            createdAt: 3_000,
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
          id: "local-compact-start",
          role: "system",
          text: "Compacting context...",
          createdAt: 1_990,
        },
        {
          id: "local-compact-end",
          role: "system",
          text: "Context compacted · 13,005 tokens summarized",
          createdAt: 2_010,
        },
        {
          id: "streaming-agent",
          role: "agent",
          text: "new answer is streaming",
        },
      ],
    });

    expect(out.messages.map((m: ChatMessage) => m.id)).toEqual([
      "old-user",
      "compaction:cmp-1",
      "old-agent",
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

  it("drops plain-text tool output copies from restored session history", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          {
            id: "tool-card",
            role: "agent",
            a2ui: {
              components: [
                {
                  id: "restored-tool-call_1",
                  type: "tool-card",
                  props: {
                    title: "bash",
                    toolName: "bash",
                    startedAt: 1_000,
                    endedAt: 2_000,
                  },
                  children: [
                    {
                      id: "result",
                      type: "code",
                      props: {
                        content:
                          "IN_NIX_SHELL=impure DEVSHELL_DIR=/nix/store/example",
                      },
                    },
                  ],
                },
              ],
            },
          },
          {
            id: "plain-copy",
            role: "agent",
            text: "IN_NIX_SHELL=impure DEVSHELL_DIR=/nix/store/example",
          },
        ],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));

    expect(out.messages.map((message: ChatMessage) => message.id)).toEqual([
      "tool-card",
    ]);
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
