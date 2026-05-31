import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLocalChatMessage,
  findSessionFileMatchingCwd,
  normalizeSessionLabel,
  parseSessionHistoryLines,
  readSessionLabel,
  readSessionMetadata,
  readSessionTranscript,
  writeSessionLabel,
} from "./session-history";

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
      { id: "u1", role: "user", text: "hello" },
      {
        id: "a1",
        role: "agent",
        text: "Hi there.",
        thinking: "hidden reasoning",
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
        a2ui: {
          components: [
            {
              id: "restored-tool-call-read-1",
              type: "tool-card",
              props: {
                title: "read",
                toolName: "read",
                description: "src/App.tsx",
                startedAt: 1_000,
                endedAt: 2_500,
              },
              children: [
                {
                  id: "restored-tool-call-read-1-result",
                  type: "code",
                  props: {
                    content: "export function App() {}",
                    language: "tsx",
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
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
    expect(parsed[0]).toEqual({ id: "m5", role: "user", text: "message 5" });
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
      { id: "new", role: "agent", text: "new" },
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
      { id: "pi-user", role: "user", text: "hi" },
      { id: "slash-user", role: "user", text: "/context", createdAt: 1 },
      {
        id: "slash-output",
        role: "system",
        text: "## Context",
        createdAt: 2,
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
      { id: "pi-user", role: "user", text: "Please work on issue 85" },
      { id: "pi-agent", role: "agent", text: "Working on it" },
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
      { id: "pi-agent", role: "agent", text: "all done", createdAt: 1_000 },
      { id: "text-2", role: "agent", text: "done", createdAt: 2_000 },
    ]);
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
      { id: "leak.jsonl-u", role: "user", text: "from other" },
    ]);
    // With the cwd filter, the older matching session is returned.
    await expect(readSessionTranscript(dir, "/tmp/target")).resolves.toEqual([
      { id: "old.jsonl-u", role: "user", text: "from target" },
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
      { id: "target.jsonl-u", role: "user", text: "from target" },
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
