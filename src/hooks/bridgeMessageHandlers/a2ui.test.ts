import { describe, expect, it, vi } from "vitest";
import { handleA2ui } from "./a2ui";
import { handleResponseDelta } from "./responseDelta";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";
import type { ChatMessage } from "../../types/a2ui";

function applyAppendByMessageId(
  tab: ReturnType<typeof makeEmptyTab>,
  msg: ChatMessage,
) {
  const messages = [...tab.messages];
  const index = messages.findIndex((message) => message.id === msg.id);
  if (index >= 0) messages[index] = msg;
  else messages.push(msg);
  return { ...tab, messages };
}

describe("handleA2ui", () => {
  it("appends an a2ui bubble and flips waiting on done", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    const payload = { components: [{ id: "x", type: "container" }] };
    handleA2ui(
      {
        type: "a2ui",
        payload,
        id: "msg-1",
        done: true,
        tabId: "default",
      },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-1", role: "agent", a2ui: payload }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "ready" });
  });

  it("flushes pending streamed deltas before appending an a2ui bubble", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1" },
    });
    handleResponseDelta(
      {
        type: "response_delta",
        content: "before tool",
        messageId: "msg-1",
        tabId: "tab-1",
        channel: "thinking",
      },
      ctx,
    );

    const payload = { components: [{ id: "tool-1", type: "tool-card" }] };
    handleA2ui({ type: "a2ui", payload, id: "tool-1", tabId: "tab-1" }, ctx);

    expect(mocks.appendOrAmendAgentText).toHaveBeenCalledWith(
      "before tool",
      "msg-1",
      "tab-1",
      "thinking",
      undefined,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tool-1", role: "agent", a2ui: payload }),
      "tab-1",
    );
    expect(
      mocks.appendOrAmendAgentText.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.appendMessage.mock.invocationCallOrder[0]);
  });

  it("mirrors a2ui tool cards to the durable local chat log", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1" },
    });
    const payload = {
      components: [
        {
          id: "tool-1-call-1",
          type: "tool-card",
          props: { toolName: "bash", startedAt: 1_000 },
        },
      ],
    };

    handleA2ui(
      { type: "a2ui", payload, id: "tool-1-call-1", tabId: "tab-1" },
      ctx,
    );

    expect(mocks.persistLocalChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tool-1-call-1",
        role: "agent",
        a2ui: payload,
        createdAt: 1_000,
      }),
      "tab-1",
    );
  });

  it("updates a running task_batch tool card by identity when message ids differ", () => {
    let tab = makeEmptyTab("tab-1", "Tab 1");
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    ctx.updateTab = vi.fn((_tabId, updater) => {
      tab = updater(tab);
    });
    ctx.appendMessage = vi.fn((message: ChatMessage) => {
      tab = applyAppendByMessageId(tab, message);
    });

    const startPayload = {
      components: [
        {
          id: "tool-1-call_batch_1-fc_abc",
          type: "tool-card",
          props: {
            title: "task_batch",
            toolName: "task_batch",
            description: "gpt-5-4-mini, qwen3-coder · inline",
            startedAt: 1_000,
          },
          children: [],
        },
      ],
    };
    const updatePayload = {
      components: [
        {
          id: "tool-2-call_batch_1-fc_abc",
          type: "tool-card",
          props: {
            title: "task_batch",
            toolName: "task_batch",
            description: "gpt-5-4-mini, qwen3-coder · inline",
            startedAt: 1_000,
          },
          children: [
            {
              id: "tool-2-call_batch_1-fc_abc-result",
              type: "subagent-result",
              props: { content: "partial audit from subagents" },
            },
          ],
        },
      ],
    };

    handleA2ui(
      {
        type: "a2ui",
        payload: startPayload,
        id: "tool-1-call_batch_1-fc_abc",
        tabId: "tab-1",
      },
      ctx,
    );
    handleA2ui(
      {
        type: "a2ui",
        payload: updatePayload,
        id: "tool-2-call_batch_1-fc_abc",
        tabId: "tab-1",
      },
      ctx,
    );

    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0]).toMatchObject({
      id: "tool-2-call_batch_1-fc_abc",
      role: "agent",
      a2ui: updatePayload,
    });
    expect(tab.messages[0].a2ui?.components[0].children).toEqual([
      expect.objectContaining({
        type: "subagent-result",
        props: { content: "partial audit from subagents" },
      }),
    ]);
    expect(mocks.persistLocalChatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "tool-2-call_batch_1-fc_abc" }),
      "tab-1",
    );
  });

  it("merges a replayed running tool card by identity even when startedAt drifts", () => {
    // A re-emitted tool_execution_start (auto-retry / codex replay, or a worker
    // respawn that lost its uiId cache) arrives with a fresh uiId AND a fresh
    // startedAt for the same logical call. Both cards are still running (no
    // endedAt), so they must collapse to ONE card rather than showing two
    // "Running" copies of the same command.
    let tab = makeEmptyTab("tab-1", "Tab 1");
    const { ctx } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    ctx.updateTab = vi.fn((_tabId, updater) => {
      tab = updater(tab);
    });
    ctx.appendMessage = vi.fn((message: ChatMessage) => {
      tab = applyAppendByMessageId(tab, message);
    });

    const firstStart = {
      components: [
        {
          id: "tool-1-call_bash_1-fc_abc",
          type: "tool-card",
          props: {
            toolName: "bash",
            description: "bunx vitest run",
            startedAt: 1_000,
          },
          children: [],
        },
      ],
    };
    const replayedStart = {
      components: [
        {
          id: "tool-2-call_bash_1-fc_abc",
          type: "tool-card",
          props: {
            toolName: "bash",
            description: "bunx vitest run",
            // Replay minted a new clock — the merge must ignore this drift.
            startedAt: 5_000,
          },
          children: [],
        },
      ],
    };

    handleA2ui(
      {
        type: "a2ui",
        payload: firstStart,
        id: "tool-1-call_bash_1-fc_abc",
        tabId: "tab-1",
      },
      ctx,
    );
    handleA2ui(
      {
        type: "a2ui",
        payload: replayedStart,
        id: "tool-2-call_bash_1-fc_abc",
        tabId: "tab-1",
      },
      ctx,
    );

    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0]).toMatchObject({
      id: "tool-2-call_bash_1-fc_abc",
      a2ui: replayedStart,
    });
  });

  it("replaces a running task_batch card with a synthetic cancellation by identity", () => {
    let tab = makeEmptyTab("tab-1", "Tab 1");
    const { ctx } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    ctx.updateTab = vi.fn((_tabId, updater) => {
      tab = updater(tab);
    });
    ctx.appendMessage = vi.fn((message: ChatMessage) => {
      tab = applyAppendByMessageId(tab, message);
    });

    const startPayload = {
      components: [
        {
          id: "tool-1-call_batch_2-fc_def",
          type: "tool-card",
          props: {
            title: "task_batch",
            toolName: "task_batch",
            startedAt: 1_000,
          },
          children: [],
        },
      ],
    };
    const cancelPayload = {
      components: [
        {
          id: "tool-2-call_batch_2-fc_def",
          type: "tool-card",
          props: {
            title: "task_batch",
            toolName: "task_batch",
            startedAt: 1_000,
            endedAt: 1_500,
            status: "cancelled",
          },
          children: [
            {
              id: "tool-2-call_batch_2-fc_def-result",
              type: "subagent-result",
              props: { content: "Cancelled by user.", isError: true },
            },
          ],
        },
      ],
    };

    handleA2ui(
      {
        type: "a2ui",
        payload: startPayload,
        id: "tool-1-call_batch_2-fc_def",
        tabId: "tab-1",
      },
      ctx,
    );
    handleA2ui(
      {
        type: "a2ui",
        payload: cancelPayload,
        id: "tool-2-call_batch_2-fc_def",
        tabId: "tab-1",
      },
      ctx,
    );

    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0]).toMatchObject({
      id: "tool-2-call_batch_2-fc_def",
      a2ui: cancelPayload,
    });
  });

  it("preserves cancellation state when a late running update has a sibling id", () => {
    const cancelledId = "tool-1-call_batch_late-fc_jkl";
    const updateId = "tool-2-call_batch_late-fc_jkl";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id: cancelledId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: cancelledId,
                type: "tool-card",
                props: {
                  title: "task_batch",
                  toolName: "task_batch",
                  startedAt: 1_000,
                  endedAt: 1_500,
                  status: "cancelled",
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id: updateId,
          type: "tool-card",
          props: {
            title: "task_batch",
            toolName: "task_batch",
            startedAt: 1_000,
          },
          children: [
            {
              id: `${updateId}-result`,
              type: "subagent-result",
              props: { content: "late partial body" },
            },
          ],
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: updateId, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id: updateId,
      role: "agent",
      a2ui: {
        components: [
          {
            id: updateId,
            props: {
              status: "cancelled",
              startedAt: 1_000,
              endedAt: 1_500,
            },
            children: [
              {
                id: `${updateId}-late-completion-notice`,
                props: {
                  content: expect.stringContaining(
                    "reported a final result after it had already been marked stopped",
                  ),
                },
              },
              {
                id: `${updateId}-result`,
                props: { content: "late partial body" },
              },
            ],
          },
        ],
      },
    });
  });

  it("preserves cancellation state when a late final event has a sibling id", () => {
    const runningId =
      "restored-tool-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const finalId =
      "tool-2-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id: runningId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: runningId,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "sleep 60",
                  startedAt: 1_000,
                  endedAt: 1_500,
                  status: "cancelled",
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id: finalId,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "sleep 60",
            startedAt: 1_000,
            endedAt: 2_000,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: finalId, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id: finalId,
      role: "agent",
      a2ui: {
        components: [
          {
            id: finalId,
            props: {
              status: "cancelled",
              startedAt: 1_000,
              endedAt: 2_000,
            },
            children: [
              {
                id: `${finalId}-late-completion-notice`,
                props: {
                  content: expect.stringContaining(
                    "reported a final result after it had already been marked stopped",
                  ),
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("preserves cancellation state when a late final event reuses the same id", () => {
    const id = "tool-1-call_1";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id,
          role: "agent",
          a2ui: {
            components: [
              {
                id,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  startedAt: 1_000,
                  endedAt: 1_500,
                  status: "cancelled",
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            startedAt: 1_000,
            endedAt: 2_000,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages[0].a2ui?.components[0].props).toMatchObject({
      status: "cancelled",
      endedAt: 2_000,
    });
  });

  it("persists the preserved cancellation state for late final tool cards", () => {
    const id = "tool-1-call_1";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id,
          role: "agent",
          a2ui: {
            components: [
              {
                id,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  startedAt: 1_000,
                  endedAt: 1_500,
                  status: "cancelled",
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    ctx.updateTab = vi.fn((_tabId, updater) => {
      updater(tab);
    });
    const payload = {
      components: [
        {
          id,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            startedAt: 1_000,
            endedAt: 2_000,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id, tabId: "tab-1" }, ctx);

    expect(mocks.persistLocalChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        a2ui: {
          components: [
            expect.objectContaining({
              props: expect.objectContaining({
                status: "cancelled",
                endedAt: 2_000,
              }),
              children: [
                expect.objectContaining({
                  id: `${id}-late-completion-notice`,
                }),
              ],
            }),
          ],
        },
      }),
      "tab-1",
    );
  });

  it("upserts a completed tool card against the current tab even when the snapshot missed it", () => {
    const id = "tool-1-call_1";
    const snapshotTab = makeEmptyTab("tab-1", "Tab 1");
    const currentTab = {
      ...snapshotTab,
      messages: [
        {
          id,
          role: "agent",
          a2ui: {
            components: [
              {
                id,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "codex review",
                  startedAt: 1_000,
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [snapshotTab] },
    });
    const payload = {
      components: [
        {
          id,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "codex review",
            startedAt: 1_000,
            endedAt: 2_000,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(currentTab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id,
      role: "agent",
      a2ui: payload,
    });
  });

  it("prefers the current tab's exact running id over a stale snapshot identity match", () => {
    const oldId = "tool-1-call_1";
    const currentId = "tool-2-call_1";
    const snapshotTab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id: oldId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: oldId,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "older codex review",
                  startedAt: 1_000,
                  endedAt: 1_500,
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const currentTab = {
      ...snapshotTab,
      messages: [
        {
          id: currentId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: currentId,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "current codex review",
                  startedAt: 2_000,
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [snapshotTab] },
    });
    const payload = {
      components: [
        {
          id: currentId,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "current codex review",
            startedAt: 2_000,
            endedAt: 2_500,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: currentId, tabId: "tab-1" }, ctx);

    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(currentTab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id: currentId,
      a2ui: payload,
    });
  });

  it("updates same-id repeated tool calls without replacing older siblings", () => {
    const oldId = "tool-1-call_1";
    const currentId = "tool-2-call_1";
    const oldMessage = {
      id: oldId,
      role: "agent" as const,
      a2ui: {
        components: [
          {
            id: oldId,
            type: "tool-card",
            props: {
              title: "bash",
              toolName: "bash",
              startedAt: 1_000,
              endedAt: 1_500,
            },
          },
        ],
      },
    } satisfies ChatMessage;
    const currentMessage = {
      id: currentId,
      role: "agent" as const,
      a2ui: {
        components: [
          {
            id: currentId,
            type: "tool-card",
            props: { title: "bash", toolName: "bash", startedAt: 2_000 },
          },
        ],
      },
    } satisfies ChatMessage;
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [oldMessage, currentMessage],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id: currentId,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            startedAt: 2_000,
            endedAt: 2_500,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: currentId, tabId: "tab-1" }, ctx);

    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBe(oldMessage);
    expect(out.messages[1]).toMatchObject({ id: currentId, a2ui: payload });
  });

  it("replaces a stale running terminal tool card when the final event has a sibling id", () => {
    const runningId =
      "tool-1-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const finalId =
      "tool-2-call_run-fc_01a0cf101a3d1343016a14d6465b9c819b8b75c60642c6bd59";
    const tab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      messages: [
        {
          id: runningId,
          role: "agent",
          a2ui: {
            components: [
              {
                id: runningId,
                type: "tool-card",
                props: {
                  title: "bash",
                  toolName: "bash",
                  description: "sleep 60",
                  startedAt: 1_000,
                },
              },
            ],
          },
        } satisfies ChatMessage,
      ],
    };
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-1", tabs: [tab] },
    });
    const payload = {
      components: [
        {
          id: finalId,
          type: "tool-card",
          props: {
            title: "bash",
            toolName: "bash",
            description: "sleep 60",
            startedAt: 1_000,
            endedAt: 2_000,
            isError: true,
          },
        },
      ],
    };

    handleA2ui({ type: "a2ui", payload, id: finalId, tabId: "tab-1" }, ctx);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(tab);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({
      id: finalId,
      role: "agent",
      a2ui: payload,
    });
  });
});
