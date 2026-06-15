import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ForgetInput, ForgetResult, RememberInput, RememberResult, ResolvedMemoryScope } from "./types";

function normalizeEntryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function entryHash(scope: ResolvedMemoryScope, text: string): string {
  return createHash("sha256")
    .update(`${scope.scope}:${scope.project?.key ?? "user"}:${normalizeEntryText(text).toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

function entryId(scope: ResolvedMemoryScope, text: string): string {
  return `mem_${entryHash(scope, text)}_${randomUUID().slice(0, 8)}`;
}

function safeTags(tags: string[] | undefined): string[] {
  return (tags ?? [])
    .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))
    .filter(Boolean)
    .slice(0, 8);
}

const writeQueues = new Map<string, Promise<unknown>>();
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const lockDir = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() >= deadline) {
        throw err;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function withMemoryWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const run = (async () => {
    await previous.catch(() => undefined);
    const release = await acquireFileLock(path);
    try {
      return await fn();
    } finally {
      await release();
    }
  })();
  writeQueues.set(path, run);
  try {
    return await run;
  } finally {
    if (writeQueues.get(path) === run) {
      writeQueues.delete(path);
    }
  }
}

function renderEntry(scope: ResolvedMemoryScope, input: RememberInput, id: string): string {
  const tags = safeTags(input.tags);
  const meta = [
    `id: ${id}`,
    `kind: ${input.kind}`,
    `created: ${new Date().toISOString()}`,
    ...(tags.length > 0 ? [`tags: ${tags.join(",")}`] : []),
    `scope: ${scope.scope}`,
  ].join("; ");
  return `- [${input.kind}] ${normalizeEntryText(input.text)} <!-- ${meta} -->`;
}

function lineHasId(line: string, id: string): boolean {
  return line.includes(`id: ${id}`) || line.includes(`id:${id}`);
}

function lineText(line: string): string {
  return line.replace(/<!--.*?-->/g, "").replace(/^\s*-\s*(\[[^\]]+\]\s*)?/, "").trim();
}

export async function readMemoryFile(scope: ResolvedMemoryScope): Promise<string> {
  try {
    return await readFile(scope.memoryPath, "utf8");
  } catch {
    return "";
  }
}

async function writeMemoryFile(scope: ResolvedMemoryScope, content: string): Promise<void> {
  await mkdir(scope.topicsDir, { recursive: true });
  await writeFile(scope.memoryPath, content, "utf8");
}

export async function rememberEntry(
  scope: ResolvedMemoryScope,
  input: RememberInput,
): Promise<RememberResult> {
  return withMemoryWriteLock(scope.memoryPath, async () => {
    const text = normalizeEntryText(input.text);
    if (!text) throw new Error("memory text is required");
    const current = await readMemoryFile(scope);
    const duplicate = current
      .split(/\r?\n/)
      .find((line) => lineText(line).toLowerCase() === text.toLowerCase());
    if (duplicate) {
      const existingId = duplicate.match(/id:\s*([^;\s]+)/)?.[1] ?? entryHash(scope, text);
      return { id: existingId, created: false, path: scope.memoryPath };
    }

    const id = entryId(scope, text);
    const header = current.trim().length === 0 ? "# Aethon memory\n\n" : "";
    const prefix = current.trim().length === 0 ? header : current.replace(/\s*$/, "\n");
    await writeMemoryFile(scope, `${prefix}${renderEntry(scope, { ...input, text }, id)}\n`);
    return { id, created: true, path: scope.memoryPath };
  });
}

export async function forgetMemoryEntry(
  scope: ResolvedMemoryScope,
  input: ForgetInput,
): Promise<ForgetResult> {
  return withMemoryWriteLock(scope.memoryPath, async () => {
    const current = await readMemoryFile(scope);
    const targetText = input.text ? normalizeEntryText(input.text).toLowerCase() : undefined;
    let removed = 0;
    const kept = current.split(/\r?\n/).filter((line) => {
      const match =
        (input.id ? lineHasId(line, input.id) : false) ||
        (targetText ? lineText(line).toLowerCase() === targetText : false);
      if (match) removed += 1;
      return !match;
    });
    if (removed > 0) {
      await writeMemoryFile(scope, kept.join("\n").replace(/\n{3,}/g, "\n\n"));
    }
    return { removed, path: scope.memoryPath };
  });
}
