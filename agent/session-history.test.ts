import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSessionHistoryLines,
  readSessionMetadata,
  readSessionTranscript,
} from "./session-history";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aethon-session-history-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
        id: "tool-1",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output" }],
        },
      }),
      "not-json",
    ];

    expect(parseSessionHistoryLines(lines)).toEqual([
      { id: "u1", role: "user", text: "hello" },
      { id: "a1", role: "agent", text: "Hi there." },
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
        message: { role: "assistant", content: [{ type: "text", text: "new" }] },
      })}\n`,
    );
    await utimes(oldPath, new Date(1_000), new Date(1_000));
    await utimes(newPath, new Date(2_000), new Date(2_000));

    await expect(readSessionTranscript(dir)).resolves.toEqual([
      { id: "new", role: "agent", text: "new" },
    ]);
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
});
