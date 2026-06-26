import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLocalChatMessage,
  findDanglingSubagentToolCalls,
  findSessionFileMatchingCwd,
  normalizeSessionLabel,
  parseSessionHistoryLines,
  readSessionLabel,
  readSessionMetadata,
  readSessionTranscript,
  repairDanglingSubagentToolResults,
  writeSessionLabel,
} from "./session-history";
import { __testing as restoreTesting } from "./session-history/restore";
import { SESSION_TITLE_TOOL_NAME } from "./silent-tools";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aethon-session-history-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parseSessionHistoryLines", () => {
  it("restores visible user and assistant text from pi session messages", () => {
    const lines = [
      JSON.stringify({
        type: "session",
        id: "session-1",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden reasoning" },
            { type: "text", text: "Hi there." },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "empty",
        message: {
          role: "assistant",
          content: [],
        },
      }),
      "not-json",
    ];

    expect(parseSessionHistoryLines(lines)).toEqual([
      { id: "u1", entryId: "u1", role: "user", text: "hello" },
      {
        id: "a1",
        entryId: "a1",
        role: "agent",
        text: "Hi there.",
        thinking: "hidden reasoning",
      },
    ]);
  });

  it("attaches model_change records to the restored assistant message", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
      }),
      JSON.stringify({
        type: "model_change",
        parentId: "a1",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Next." }],
        },
      }),
    ];

    expect(parseSessionHistoryLines(lines)).toEqual([
      {
        id: "a1",
        entryId: "a1",
        role: "agent",
        text: "Done.",
        model: "openai-codex/gpt-5.5",
      },
      {
        id: "a2",
        entryId: "a2",
        role: "agent",
        text: "Next.",
        model: "openai-codex/gpt-5.5",
      },
    ]);
  });

  it("restores completed tool calls as stable tool-card messages", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        message: {
          role: "assistant",
          timestamp: 1_000,
          content: [
            {
              type: "toolCall",
              id: "call-read-1",
              name: "read",
              arguments: { path: "src/App.tsx" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "result-tool",
        message: {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "export function App() {}" }],
          isError: false,
          timestamp: 2_500,
        },
      }),
    ];

    expect(parseSessionHistoryLines(lines)).toEqual([
      {
        id: "restored-tool-call-read-1",
        role: "agent",
        createdAt: 1_000,
        a2ui: {
          components: [
            {
              id: "restored-tool-call-read-1",
              type: "tool-card",
              props: {
                title: "read",
                toolName: "read",
                description: "src/App.tsx",
                filePath: "src/App.tsx",
                startedAt: 1_000,
                endedAt: 2_500,
              },
              // A successful read renders as a clickable filename — no
              // file-content child is emitted.
              children: [],
            },
          ],
        },
      },
    ]);
  });

  it("restores edit tool cards with file-change metadata", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        message: {
          role: "assistant",
          timestamp: 1_000,
          content: [
            {
              type: "toolCall",
              id: "call-edit-1",
              name: "edit",
              arguments: { path: "src/App.tsx" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "result-tool",
        message: {
          role: "toolResult",
          toolCallId: "call-edit-1",
          toolName: "edit",
          content: [
            {
              type: "text",
              text: "--- a/src/App.tsx\n+++ b/src/App.tsx\n-old\n+new",
            },
          ],
          isError: false,
          timestamp: 2_500,
        },
      }),
    ];

    const restored = parseSessionHistoryLines(lines);
    expect(restored[0]?.a2ui?.components[0]).toMatchObject({
      type: "tool-card",
      props: {
        toolName: "edit",
        fileChange: {
          kind: "edited",
          path: "src/App.tsx",
          additions: 1,
          deletions: 1,
        },
      },
    });
  });

  it("preserves failed tool result state when restoring tool cards", () => {
    const restored = parseSessionHistoryLines([
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bash-1",
              name: "bash",
              arguments: { command: "false" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "result-tool",
        message: {
          role: "toolResult",
          toolCallId: "call-bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "Command failed" }],
          isError: true,
        },
      }),
    ]);

    expect(restored).toHaveLength(1);
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      type: "tool-card",
      props: {
        title: "bash",
        toolName: "bash",
        description: "false",
        isError: true,
      },
    });
  });

  it("keeps unmatched historical tool calls visible while waiting for a result", () => {
    const restored = parseSessionHistoryLines([
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        message: {
          role: "assistant",
          timestamp: 7_000,
          content: [
            {
              type: "toolCall",
              id: "call-grep-1",
              name: "grep",
              arguments: { pattern: "needle", path: "src" },
            },
          ],
        },
      }),
    ]);

    expect(restored).toEqual([
      {
        id: "restored-tool-call-grep-1",
        role: "agent",
        createdAt: 7_000,
        a2ui: {
          components: [
            {
              id: "restored-tool-call-grep-1",
              type: "tool-card",
              props: {
                title: "grep",
                toolName: "grep",
                description: "needle in src",
                startedAt: 7_000,
              },
              children: [],
            },
          ],
        },
      },
    ]);
  });

  it("detects dangling task and task_batch tool calls that lack results", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_task", name: "task" },
            { type: "toolCall", id: "call_batch", name: "task_batch" },
            { type: "toolCall", id: "call_bash", name: "bash" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_task",
          toolName: "task",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ];

    expect(findDanglingSubagentToolCalls(lines)).toEqual([
      { toolCallId: "call_batch", toolName: "task_batch" },
    ]);
  });

  it("does not restore silent session-title tool calls as visible cards", () => {
    const restored = parseSessionHistoryLines([
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will take a look." },
            {
              type: "toolCall",
              id: "call-title-1",
              name: SESSION_TITLE_TOOL_NAME,
              arguments: { title: "Prompt polish" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "result-tool",
        message: {
          role: "toolResult",
          toolCallId: "call-title-1",
          toolName: SESSION_TITLE_TOOL_NAME,
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      }),
    ]);

    expect(restored).toEqual([
      {
        id: "assistant-tool",
        entryId: "assistant-tool",
        role: "agent",
        text: "I will take a look.",
      },
    ]);
  });

  it("restores pi compaction entries as durable timeline markers", () => {
    const parsed = parseSessionHistoryLines([
      JSON.stringify({
        type: "message",
        id: "before",
        timestamp: "2026-06-02T13:23:02.101Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "before compaction" }],
        },
      }),
      JSON.stringify({
        type: "compaction",
        id: "cmp-1",
        parentId: "before",
        timestamp: "2026-06-02T13:28:04.875Z",
        summary: "Older work was summarized.",
        tokensBefore: 13_005,
      }),
    ]);

    expect(parsed).toEqual([
      {
        id: "before",
        entryId: "before",
        role: "agent",
        text: "before compaction",
        createdAt: Date.parse("2026-06-02T13:23:02.101Z"),
      },
      {
        id: "compaction:cmp-1",
        role: "system",
        text: "Context compacted · 13,005 tokens summarized",
        createdAt: Date.parse("2026-06-02T13:28:04.875Z"),
      },
    ]);
  });

  it("keeps the most recent bounded set of restored messages", () => {
    const lines = Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({
        type: "message",
        id: `m${index}`,
        message: {
          role: "user",
          content: [{ type: "text", text: `message ${index}` }],
        },
      }),
    );

    const parsed = parseSessionHistoryLines(lines);
    expect(parsed).toHaveLength(200);
    expect(parsed[0]).toEqual({
      id: "m5",
      entryId: "m5",
      role: "user",
      text: "message 5",
    });
  });
});

describe("readSessionTranscript", () => {
  it("reads the newest jsonl file from a session directory", async () => {
    const dir = await tempRoot();
    const oldPath = join(dir, "old.jsonl");
    const newPath = join(dir, "new.jsonl");
    await writeFile(
      oldPath,
      `${JSON.stringify({
        type: "message",
        id: "old",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      })}\n`,
    );
    await writeFile(
      newPath,
      `${JSON.stringify({
        type: "message",
        id: "new",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "new" }],
        },
      })}\n`,
    );
    await utimes(oldPath, new Date(1_000), new Date(1_000));
    await utimes(newPath, new Date(2_000), new Date(2_000));

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      { id: "new", entryId: "new", role: "agent", text: "new" },
    ]);
  });

  it("appends Aethon-local slash command messages to restored history", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: "pi-user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "slash-user",
      role: "user",
      text: "/context",
      createdAt: 1,
    });
    await appendLocalChatMessage(dir, {
      id: "slash-output",
      role: "system",
      text: "## Context",
      createdAt: 2,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      { id: "pi-user", entryId: "pi-user", role: "user", text: "hi" },
      { id: "slash-user", role: "user", text: "/context", createdAt: 1 },
      {
        id: "slash-output",
        role: "system",
        text: "## Context",
        createdAt: 2,
      },
    ]);
  });

  it("restores Aethon-local system messages inline by creation time", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "message",
          id: "pi-user",
          timestamp: 1_000,
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "pi-agent",
          timestamp: 3_000,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n") + "\n",
    );
    await appendLocalChatMessage(dir, {
      id: "stderr-warning",
      role: "system",
      text: "[agent stderr] transient provider error",
      createdAt: 2_000,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-user",
        entryId: "pi-user",
        role: "user",
        text: "hi",
        createdAt: 1_000,
      },
      {
        id: "stderr-warning",
        role: "system",
        text: "[agent stderr] transient provider error",
        createdAt: 2_000,
      },
      {
        id: "pi-agent",
        entryId: "pi-agent",
        role: "agent",
        text: "done",
        createdAt: 3_000,
      },
    ]);
  });

  it("preserves Aethon-local assistant model labels", async () => {
    const dir = await tempRoot();
    await appendLocalChatMessage(dir, {
      id: "agent-1",
      role: "agent",
      text: "streamed answer",
      model: "openai-codex/gpt-5.5",
      createdAt: 1,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "agent-1",
        role: "agent",
        text: "streamed answer",
        model: "openai-codex/gpt-5.5",
        createdAt: 1,
      },
    ]);
  });

  it("dedupes live compaction notices when pi restored the compaction entry", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "message",
          id: "pi-user",
          timestamp: 1_000,
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "cmp-1",
          timestamp: 2_000,
          summary: "Older work was summarized.",
          tokensBefore: 13_005,
        }),
        JSON.stringify({
          type: "message",
          id: "pi-agent",
          timestamp: 3_000,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n") + "\n",
    );
    await appendLocalChatMessage(dir, {
      id: "compact-start",
      role: "system",
      text: "Compacting context...",
      createdAt: 1_990,
    });
    await appendLocalChatMessage(dir, {
      id: "compact-done",
      role: "system",
      text: "Context compacted · 13,005 tokens summarized",
      createdAt: 2_010,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-user",
        entryId: "pi-user",
        role: "user",
        text: "hi",
        createdAt: 1_000,
      },
      {
        id: "compaction:cmp-1",
        role: "system",
        text: "Context compacted · 13,005 tokens summarized",
        createdAt: 2_000,
      },
      {
        id: "pi-agent",
        entryId: "pi-agent",
        role: "agent",
        text: "done",
        createdAt: 3_000,
      },
    ]);
  });

  it("restores local image attachments from the durable chat log", async () => {
    const dir = await tempRoot();
    await appendLocalChatMessage(dir, {
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
      createdAt: 1,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
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
        createdAt: 1,
      },
    ]);
  });

  it("drops non-durable preview URLs from local attachment history", async () => {
    const dir = await tempRoot();
    const attachmentWithPreview = {
      id: "img-1",
      kind: "image" as const,
      path: "/tmp/aethon-pastes/one.png",
      name: "one.png",
      mimeType: "image/png",
      sizeBytes: 12,
      previewUrl: "blob:temp",
    };
    await appendLocalChatMessage(dir, {
      id: "image-with-preview",
      role: "user",
      text: "see this",
      attachments: [attachmentWithPreview],
      createdAt: 1,
    });

    const transcript = await readSessionTranscript(dir);
    expect(transcript[0].attachments).toEqual([
      {
        id: "img-1",
        kind: "image",
        path: "/tmp/aethon-pastes/one.png",
        name: "one.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
    ]);
  });

  it("merges local attachment metadata into matching pi user messages", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "pi-user",
        timestamp: 1_500,
        message: {
          role: "user",
          content: [{ type: "text", text: "what is this?" }],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "local-user",
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
      createdAt: 1_000,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-user",
        entryId: "pi-user",
        role: "user",
        text: "what is this?",
        createdAt: 1_500,
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

  it("does not duplicate local prompt snapshots already present in pi history", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: "pi-user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please work on issue 85" }],
        },
      })}\n${JSON.stringify({
        type: "message",
        id: "pi-agent",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working on it" }],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "local-user",
      role: "user",
      text: "Please work on issue 85",
      createdAt: 1,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-user",
        entryId: "pi-user",
        role: "user",
        text: "Please work on issue 85",
      },
      {
        id: "pi-agent",
        entryId: "pi-agent",
        role: "agent",
        text: "Working on it",
      },
    ]);
  });

  it("drops local streamed thinking slices already covered by pi history", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "pi-agent",
        timestamp: 1779979121365,
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "**Earlier reasoning**\n\nstep one\n\n**Later reasoning**\n\nstep two",
            },
          ],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "text-1779979103491",
      role: "agent",
      thinking: "**Later reasoning**\n\nstep two",
      createdAt: 1779979120970,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-agent",
        entryId: "pi-agent",
        role: "agent",
        thinking:
          "**Earlier reasoning**\n\nstep one\n\n**Later reasoning**\n\nstep two",
        createdAt: 1779979121365,
      },
    ]);
  });

  it("keeps later local streamed snapshots even when their text appears in earlier pi history", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "pi-agent",
        timestamp: 1_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "all done" }],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "text-2",
      role: "agent",
      text: "done",
      createdAt: 2_000,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "pi-agent",
        entryId: "pi-agent",
        role: "agent",
        text: "all done",
        createdAt: 1_000,
      },
      { id: "text-2", role: "agent", text: "done", createdAt: 2_000 },
    ]);
  });

  it("orders pi tool activity after stale local streaming snapshots on restore", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool",
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bash-after-restart",
              name: "bash",
              arguments: { command: "git push" },
            },
          ],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "text-stale-thinking",
      role: "agent",
      thinking: "Inspecting code status",
      createdAt: 2_000,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "text-stale-thinking",
      "restored-tool-call-bash-after-restart",
    ]);
    expect(restored.at(-1)?.a2ui?.components[0]).toMatchObject({
      type: "tool-card",
      props: { toolName: "bash", startedAt: 3_000 },
    });
  });

  it("keeps locally cancelled tool cards ahead of late pi completions on restore", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool",
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_late_1|fc_abc",
              name: "bash",
              arguments: { command: "sleep 60" },
            },
          ],
        },
      })}\n${JSON.stringify({
        type: "message",
        id: "tool-result",
        timestamp: 5_000,
        message: {
          role: "toolResult",
          toolCallId: "call_late_1|fc_abc",
          toolName: "bash",
          content: [{ type: "text", text: "done" }],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "tool-7-call_late_1-fc_abc",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-7-call_late_1-fc_abc",
            type: "tool-card",
            props: {
              toolName: "bash",
              startedAt: 3_000,
              endedAt: 4_000,
              status: "cancelled",
            },
          },
        ],
      },
      createdAt: 4_000,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "tool-7-call_late_1-fc_abc",
    ]);
    expect(restored[0].a2ui?.components[0].props).toMatchObject({
      status: "cancelled",
      endedAt: 4_000,
    });
  });

  it("repairs dangling subagent tool calls with synthetic error results", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool",
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_batch_1",
              name: "task_batch",
              arguments: { tasks: [] },
            },
          ],
        },
      })}\n`,
    );

    await expect(repairDanglingSubagentToolResults(path)).resolves.toBe(1);
    const repairedLines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
    const repairedRecord = JSON.parse(repairedLines.at(-1) ?? "{}");
    expect(repairedRecord).toMatchObject({
      type: "message",
      parentId: "assistant-tool",
      message: {
        role: "toolResult",
        toolCallId: "call_batch_1",
        isError: true,
      },
    });

    const restored = await readSessionTranscript(dir);
    expect(restored).toHaveLength(1);
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      type: "tool-card",
      props: {
        toolName: "task_batch",
        isError: true,
      },
    });
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      children: [
        {
          props: {
            content: expect.stringContaining("delegation as cancelled/failed"),
          },
        },
      ],
    });
    await expect(repairDanglingSubagentToolResults(path)).resolves.toBe(0);
  });

  it("does not repair dangling subagent calls from inactive branches", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          id: "session-1",
          cwd: "/repo",
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "abandoned-assistant",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_old", name: "task_batch" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "active-assistant",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "new branch" }],
          },
        }),
      ].join("\n") + "\n",
    );

    await expect(repairDanglingSubagentToolResults(path)).resolves.toBe(0);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("aethon-synthetic-tool-result");
  });

  it("uses non-message entries when identifying the active repair branch", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", id: "session-1", cwd: "/repo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "abandoned-assistant",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_old", name: "task_batch" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "active-assistant",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "new branch" }],
          },
        }),
        JSON.stringify({
          type: "model_change",
          id: "active-model",
          parentId: "active-assistant",
          timestamp: "2026-06-23T00:00:00.000Z",
          provider: "anthropic",
          modelId: "claude",
        }),
      ].join("\n") + "\n",
    );

    await expect(repairDanglingSubagentToolResults(path)).resolves.toBe(0);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("aethon-synthetic-tool-result");
  });

  it("does not repair stale dangling subagent calls after conversation continued", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", id: "session-1", cwd: "/repo" }),
        JSON.stringify({
          type: "message",
          id: "u1",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-tool",
          parentId: "u1",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_old", name: "task_batch" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "u2",
          parentId: "assistant-tool",
          message: {
            role: "user",
            content: [{ type: "text", text: "continue" }],
          },
        }),
      ].join("\n") + "\n",
    );

    await expect(repairDanglingSubagentToolResults(path)).resolves.toBe(0);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("aethon-synthetic-tool-result");
  });

  it("keeps repaired subagent pi results ahead of local cancelled cards", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool",
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_batch_1",
              name: "task_batch",
              arguments: { tasks: [] },
            },
          ],
        },
      })}\n${JSON.stringify({
        type: "message",
        id: "tool-result",
        timestamp: 4_000,
        message: {
          role: "toolResult",
          toolCallId: "call_batch_1",
          toolName: "task_batch",
          content: [{ type: "text", text: "cancelled synthetic result" }],
          isError: true,
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "tool-7-call_batch_1",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-7-call_batch_1",
            type: "tool-card",
            props: {
              toolName: "task_batch",
              startedAt: 3_000,
              endedAt: 3_500,
              status: "cancelled",
            },
          },
        ],
      },
      createdAt: 3_500,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "restored-tool-call_batch_1",
    ]);
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      props: {
        toolName: "task_batch",
        isError: true,
      },
      children: [{ props: { content: "cancelled synthetic result" } }],
    });
  });

  it("dedupes locally mirrored live tool cards once pi history has the same tool", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool",
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_live_1|fc_abc",
              name: "bash",
              arguments: { command: "nix flake check" },
            },
          ],
        },
      })}\n`,
    );
    await appendLocalChatMessage(dir, {
      id: "tool-7-call_live_1-fc_abc",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-7-call_live_1-fc_abc",
            type: "tool-card",
            props: {
              toolName: "bash",
              startedAt: 3_000,
            },
          },
        ],
      },
      createdAt: 3_000,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "restored-tool-call_live_1-fc_abc",
    ]);
  });

  it("merges local file-change metadata into restored pi tool cards", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      [
        JSON.stringify({
          type: "message",
          id: "assistant-tool",
          timestamp: 3_000,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_edit_1",
                name: "edit",
                arguments: {
                  path: "src/App.tsx",
                  oldString: "old",
                  newString: "new",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          timestamp: 3_100,
          message: {
            role: "toolResult",
            toolCallId: "call_edit_1",
            toolName: "edit",
            content: [
              {
                type: "text",
                text: "Successfully replaced 1 block(s) in src/App.tsx",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    await appendLocalChatMessage(dir, {
      id: "tool-7-call_edit_1",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-7-call_edit_1",
            type: "tool-card",
            props: {
              toolName: "edit",
              startedAt: 3_000,
              endedAt: 3_100,
              fileChange: {
                kind: "edited",
                path: "src/App.tsx",
                rootPath: "/repo",
                preview: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@\n-old\n+new",
                additions: 1,
                deletions: 1,
              },
            },
          },
        ],
      },
      createdAt: 3_100,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "restored-tool-call_edit_1",
    ]);
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      props: {
        toolName: "edit",
        fileChange: {
          path: "src/App.tsx",
          rootPath: "/repo",
          preview: expect.stringContaining("--- a/src/App.tsx"),
          additions: 1,
          deletions: 1,
        },
      },
    });
  });

  it("restores multi-edit file-change snapshots from pi transcripts", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      [
        JSON.stringify({
          type: "message",
          id: "assistant-tool",
          timestamp: 3_000,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_edit_multi",
                name: "edit",
                arguments: {
                  path: "src/App.tsx",
                  edits: [
                    { oldText: "old one", newText: "new one" },
                    { oldText: "old two", newText: "new two\nnew extra" },
                  ],
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          timestamp: 3_100,
          message: {
            role: "toolResult",
            toolCallId: "call_edit_multi",
            toolName: "edit",
            content: [
              {
                type: "text",
                text: "Successfully replaced 2 block(s) in src/App.tsx",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const restored = await readSessionTranscript(dir);
    expect(restored).toHaveLength(1);
    expect(restored[0].a2ui?.components[0]).toMatchObject({
      props: {
        fileChange: {
          path: "src/App.tsx",
          preview: expect.stringContaining("@@ edit 2 @@"),
          additions: 3,
          deletions: 2,
        },
      },
    });
  });

  it("prefers durable unified diff snapshots over non-diff tool status text", () => {
    const merged = restoreTesting.mergeFileChange(
      {
        kind: "edited",
        path: "src/App.tsx",
        preview: "Successfully replaced 1 block(s) in src/App.tsx",
        additions: 9,
        deletions: 9,
      },
      {
        kind: "edited",
        path: "src/App.tsx",
        rootPath: "/repo",
        preview: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@\n-old\n+new",
        additions: 1,
        deletions: 1,
      },
    );

    expect(merged).toMatchObject({
      kind: "edited",
      path: "src/App.tsx",
      rootPath: "/repo",
      preview: expect.stringContaining("--- a/src/App.tsx"),
      additions: 1,
      deletions: 1,
    });
    expect(merged.preview).not.toContain("Successfully replaced");
  });

  it("keeps the latest local assistant snapshot for stopped turns", async () => {
    const dir = await tempRoot();
    await appendLocalChatMessage(dir, {
      id: "agent-live",
      role: "agent",
      thinking: "Inspecting",
      createdAt: 1,
    });
    await appendLocalChatMessage(dir, {
      id: "agent-live",
      role: "agent",
      thinking: "Inspecting\nReading files",
      text: "Partial answer",
      createdAt: 2,
    });

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "agent-live",
        role: "agent",
        thinking: "Inspecting\nReading files",
        text: "Partial answer",
        createdAt: 2,
      },
    ]);
  });

  it("keeps the latest local tool-card snapshot by logical identity", async () => {
    const dir = await tempRoot();
    await appendLocalChatMessage(dir, {
      id: "tool-1-call_batch_3-fc_ghi",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-1-call_batch_3-fc_ghi",
            type: "tool-card",
            props: {
              toolName: "task_batch",
              startedAt: 1_000,
            },
            children: [],
          },
        ],
      },
      createdAt: 1_000,
    });
    await appendLocalChatMessage(dir, {
      id: "tool-2-call_batch_3-fc_ghi",
      role: "agent",
      a2ui: {
        components: [
          {
            id: "tool-2-call_batch_3-fc_ghi",
            type: "tool-card",
            props: {
              toolName: "task_batch",
              startedAt: 1_000,
            },
            children: [
              {
                id: "tool-2-call_batch_3-fc_ghi-result",
                type: "subagent-result",
                props: { content: "partial body" },
              },
            ],
          },
        ],
      },
      createdAt: 1_100,
    });

    const restored = await readSessionTranscript(dir);
    expect(restored.map((message) => message.id)).toEqual([
      "tool-2-call_batch_3-fc_ghi",
    ]);
    expect(restored[0].a2ui?.components[0].children).toEqual([
      expect.objectContaining({
        type: "subagent-result",
        props: { content: "partial body" },
      }),
    ]);
  });

  it("bounds the Aethon-local slash command overlay on append", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "pi-user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      })}\n`,
    );
    for (let i = 0; i < 405; i++) {
      await appendLocalChatMessage(dir, {
        id: `local-${i}`,
        role: "system",
        text: `local ${i}`,
        createdAt: i,
      });
    }

    const restored = await readSessionTranscript(dir);
    expect(restored.at(1)).toEqual({
      id: "local-206",
      role: "system",
      text: "local 206",
      createdAt: 206,
    });
    expect(restored.at(-1)).toEqual({
      id: "local-404",
      role: "system",
      text: "local 404",
      createdAt: 404,
    });
    expect(restored).toHaveLength(200);
  });

  it("reads project cwd metadata from the newest session log", async () => {
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "session",
        cwd: "/tmp/project",
      })}\n${JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      })}\n`,
    );

    await expect(readSessionMetadata(dir)).resolves.toMatchObject({
      cwd: "/tmp/project",
    });
  });

  it("reports cwdExists: false when the session cwd directory is missing", async () => {
    const deleted = await tempRoot();
    await rm(deleted, { recursive: true, force: true });
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "s",
        cwd: deleted,
      })}\n`,
    );
    const meta = await readSessionMetadata(dir);
    expect(meta?.cwd).toBe(deleted);
    expect(meta?.cwdExists).toBe(false);
  });

  it("reports cwdExists: true when the session cwd directory exists", async () => {
    const existingDir = await tempRoot();
    const dir = await tempRoot();
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        id: "s",
        cwd: existingDir,
      })}\n`,
    );
    const meta = await readSessionMetadata(dir);
    expect(meta?.cwd).toBe(existingDir);
    expect(meta?.cwdExists).toBe(true);
  });

  it("round-trips a custom session label and surfaces it through readSessionMetadata", async () => {
    const dir = await tempRoot();
    await writeFile(
      join(dir, "session.jsonl"),
      `${JSON.stringify({ type: "session", id: "x", cwd: "/tmp/p" })}\n`,
    );
    expect(await readSessionLabel(dir)).toBeUndefined();
    await writeSessionLabel(dir, "  Refactor pass  ");
    expect(await readSessionLabel(dir)).toBe("Refactor pass");
    const meta = await readSessionMetadata(dir);
    expect(meta?.customLabel).toBe("Refactor pass");
    // Empty label clears the file.
    await writeSessionLabel(dir, "");
    expect(await readSessionLabel(dir)).toBeUndefined();
  });
});

describe("normalizeSessionLabel", () => {
  it("trims and applies the same length limit pi receives", () => {
    expect(normalizeSessionLabel(`  ${"a".repeat(130)}  `)).toBe(
      "a".repeat(120),
    );
  });
});

describe("readSessionTranscript with expectedCwd", () => {
  // Helper: write a minimal one-message session for a given cwd.
  async function writeMiniSession(
    dir: string,
    name: string,
    cwd: string,
    text: string,
    mtimeSec: number,
  ): Promise<void> {
    const path = join(dir, name);
    const lines = [
      JSON.stringify({ type: "session", id: name, cwd }),
      JSON.stringify({
        type: "message",
        id: `${name}-u`,
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ];
    await writeFile(path, `${lines.join("\n")}\n`);
    await utimes(path, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000));
  }

  it("returns the matching project's session, not the latest by mtime", async () => {
    const dir = await tempRoot();
    await writeMiniSession(
      dir,
      "old.jsonl",
      "/tmp/target",
      "from target",
      1_000,
    );
    await writeMiniSession(
      dir,
      "leak.jsonl",
      "/tmp/other",
      "from other",
      9_000,
    );
    // Without the cwd filter the latest mtime ("leak.jsonl") wins.
    await expect(readSessionTranscript(dir)).resolves.toEqual([
      {
        id: "leak.jsonl-u",
        entryId: "leak.jsonl-u",
        role: "user",
        text: "from other",
      },
    ]);
    // With the cwd filter, the older matching session is returned.
    await expect(readSessionTranscript(dir, "/tmp/target")).resolves.toEqual([
      {
        id: "old.jsonl-u",
        entryId: "old.jsonl-u",
        role: "user",
        text: "from target",
      },
    ]);
  });

  it("returns no messages when no session matches the requested cwd", async () => {
    const dir = await tempRoot();
    await writeMiniSession(
      dir,
      "other.jsonl",
      "/tmp/other",
      "from other",
      1_000,
    );
    await expect(readSessionTranscript(dir, "/tmp/target")).resolves.toEqual(
      [],
    );
  });

  it("filters Aethon-local slash overlay by cwd when restoring a scoped session", async () => {
    const dir = await tempRoot();
    await writeMiniSession(
      dir,
      "target.jsonl",
      "/tmp/target",
      "from target",
      1_000,
    );
    await appendLocalChatMessage(dir, {
      id: "target-local",
      role: "system",
      text: "target context",
      cwd: "/tmp/target",
      createdAt: 1,
    });
    await appendLocalChatMessage(dir, {
      id: "other-local",
      role: "system",
      text: "other context",
      cwd: "/tmp/other",
      createdAt: 2,
    });

    await expect(readSessionTranscript(dir, "/tmp/target")).resolves.toEqual([
      {
        id: "target.jsonl-u",
        entryId: "target.jsonl-u",
        role: "user",
        text: "from target",
      },
      {
        id: "target-local",
        role: "system",
        text: "target context",
        createdAt: 1,
        cwd: "/tmp/target",
      },
    ]);
  });

  it("restores Aethon-local slash overlay when no pi session log exists", async () => {
    const dir = await tempRoot();
    await appendLocalChatMessage(dir, {
      id: "target-local",
      role: "system",
      text: "target context",
      cwd: "/tmp/target",
      createdAt: 1,
    });
    await appendLocalChatMessage(dir, {
      id: "other-local",
      role: "system",
      text: "other context",
      cwd: "/tmp/other",
      createdAt: 2,
    });

    await expect(readSessionTranscript(dir, "/tmp/target")).resolves.toEqual([
      {
        id: "target-local",
        role: "system",
        text: "target context",
        createdAt: 1,
        cwd: "/tmp/target",
      },
    ]);
  });

  it("does not diverge from ensureTab when no active project is set", async () => {
    // Regression — codex peer review of the cwd-scoped session fix:
    // when the bridge boots without an active project, `ensureTab`
    // filters persisted files by `process.cwd()` and creates a fresh
    // session if none match. The boot replay must scope the transcript
    // read by the same cwd; otherwise the UI displays the latest JSONL
    // from any project while the agent session is empty, and the user's
    // next prompt loses the displayed context. Caller in main.ts now
    // passes `process.cwd()` (not `undefined`) when no project is set.
    const dir = await tempRoot();
    await writeMiniSession(
      dir,
      "other.jsonl",
      "/tmp/other",
      "from other",
      9_000,
    );
    // Caller's no-project fallback (== `activeProjectCwd ?? process.cwd()`).
    await expect(readSessionTranscript(dir, process.cwd())).resolves.toEqual(
      [],
    );
  });
});

describe("findSessionFileMatchingCwd", () => {
  // Helper: write a session file with a given header.cwd at a given mtime.
  async function writeSession(
    dir: string,
    name: string,
    cwd: string | undefined,
    mtimeSec: number,
  ): Promise<string> {
    const path = join(dir, name);
    const header: Record<string, unknown> = {
      type: "session",
      id: name.replace(/\.jsonl$/, ""),
    };
    if (cwd !== undefined) header.cwd = cwd;
    await writeFile(path, `${JSON.stringify(header)}\n`);
    await utimes(path, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000));
    return path;
  }

  it("returns undefined when the directory does not exist", async () => {
    const root = await tempRoot();
    await expect(
      findSessionFileMatchingCwd(join(root, "nope"), "/tmp/project"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when no session header matches the requested cwd", async () => {
    const dir = await tempRoot();
    await writeSession(dir, "a.jsonl", "/tmp/other-project", 1_000);
    await writeSession(dir, "b.jsonl", "/tmp/another-project", 2_000);
    await expect(
      findSessionFileMatchingCwd(dir, "/tmp/target"),
    ).resolves.toBeUndefined();
  });

  it("returns the most recent session whose cwd matches", async () => {
    const dir = await tempRoot();
    await writeSession(dir, "old.jsonl", "/tmp/target", 1_000);
    const newer = await writeSession(dir, "new.jsonl", "/tmp/target", 3_000);
    // A more recent session for a *different* cwd must not be picked.
    await writeSession(dir, "leak.jsonl", "/tmp/other-project", 9_000);
    await expect(findSessionFileMatchingCwd(dir, "/tmp/target")).resolves.toBe(
      newer,
    );
  });

  it("ignores trailing slashes when comparing cwds", async () => {
    const dir = await tempRoot();
    const path = await writeSession(dir, "a.jsonl", "/tmp/project/", 1_000);
    await expect(findSessionFileMatchingCwd(dir, "/tmp/project")).resolves.toBe(
      path,
    );
  });

  it("skips legacy session files that have no cwd in the header", async () => {
    const dir = await tempRoot();
    // Legacy session: no cwd field. Must not be matched as if cwd were "".
    await writeSession(dir, "legacy.jsonl", undefined, 5_000);
    await expect(findSessionFileMatchingCwd(dir, "")).resolves.toBeUndefined();
    const fresh = await writeSession(dir, "fresh.jsonl", "/tmp/target", 1_000);
    await expect(findSessionFileMatchingCwd(dir, "/tmp/target")).resolves.toBe(
      fresh,
    );
  });

  it("resumes through symlinked cwds (macOS /tmp vs /private/tmp)", async () => {
    // The session header stores whatever process.cwd() returned. When the
    // workspace is reached through a symlink (or macOS's /tmp alias), the
    // stored path and the lookup path differ as strings but resolve to
    // the same directory — the lookup must still match instead of
    // silently starting a fresh session.
    const root = await tempRoot();
    const realDir = join(root, "real-workspace");
    const linkDir = join(root, "linked-workspace");
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    const dir = await tempRoot();
    const path = await writeSession(dir, "a.jsonl", realDir, 1_000);

    await expect(findSessionFileMatchingCwd(dir, linkDir)).resolves.toBe(path);
    // And the inverse: header recorded via the symlink, lookup via real.
    const dir2 = await tempRoot();
    const path2 = await writeSession(dir2, "b.jsonl", linkDir, 1_000);
    await expect(findSessionFileMatchingCwd(dir2, realDir)).resolves.toBe(
      path2,
    );
  });

  it("does not leak the most-recent session from another project (regression)", async () => {
    // Reproduces the "default tab loads the wrong project's chat" bug:
    // the user worked on project B last, switched to project A, and on
    // cold start the bridge resumed the latest-by-mtime session — which
    // belonged to B. ensureTab now passes the result of this helper to
    // SessionManager.open; an undefined return forces a fresh session
    // instead of opening the leaked one.
    const dir = await tempRoot();
    await writeSession(dir, "project-b-session.jsonl", "/tmp/project-b", 9_000);
    await expect(
      findSessionFileMatchingCwd(dir, "/tmp/project-a"),
    ).resolves.toBeUndefined();
  });
});
