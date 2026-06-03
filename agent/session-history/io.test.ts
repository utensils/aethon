import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLocalChatMessage, truncateLocalChatAfterEntry } from "./io";
import { LOCAL_CHAT_FILE } from "./shared";

let dir: string;

function localIds(): string[] {
  const raw = readFileSync(join(dir, LOCAL_CHAT_FILE), "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line).id as string);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aethon-io-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("truncateLocalChatAfterEntry", () => {
  it("drops rows created strictly after the cutoff", async () => {
    await appendLocalChatMessage(dir, {
      id: "a",
      role: "user",
      text: "first",
      createdAt: 100,
    });
    await appendLocalChatMessage(dir, {
      id: "b",
      role: "user",
      text: "second",
      createdAt: 200,
    });
    await appendLocalChatMessage(dir, {
      id: "c",
      role: "user",
      text: "third",
      createdAt: 300,
    });

    await truncateLocalChatAfterEntry(dir, 200);
    expect(localIds()).toEqual(["a", "b"]);
  });

  it("keeps rows without a timestamp", () => {
    const path = join(dir, LOCAL_CHAT_FILE);
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "aethon_chat",
          id: "no-ts",
          role: "user",
          text: "x",
        }),
        JSON.stringify({
          type: "aethon_chat",
          id: "newer",
          role: "user",
          text: "y",
          createdAt: 500,
        }),
      ].join("\n") + "\n",
    );
    return truncateLocalChatAfterEntry(dir, 200).then(() => {
      expect(localIds()).toEqual(["no-ts"]);
    });
  });

  it("is a no-op when the local chat file is missing", async () => {
    await expect(
      truncateLocalChatAfterEntry(dir, 100),
    ).resolves.toBeUndefined();
  });
});
