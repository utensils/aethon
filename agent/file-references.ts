import { promises as fs } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_REFS = 20;
const DEFAULT_MAX_FILE_BYTES = 128_000;
const DEFAULT_MAX_TOTAL_BYTES = 512_000;
const CONTEXT_MARKER = "<aethon_file_references";

export interface ParsedFileReference {
  raw: string;
  value: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface ResolvedFileReference {
  token: string;
  requested: string;
  path: string;
  displayPath: string;
  sizeBytes: number;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface FileReferenceExpansion {
  prompt: string;
  references: ResolvedFileReference[];
}

export interface FileReferenceExpansionOptions {
  /** Active tab/project/worktree cwd. All relative refs resolve under here. */
  cwd: string;
  /** Leading explicit subagent name, if one was accepted for this turn. */
  leadingSubagentName?: string | null;
  maxRefs?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export class FileReferenceError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`file reference validation failed: ${issues.join("; ")}`);
    this.name = "FileReferenceError";
    this.issues = issues;
  }
}

/** Parse `@file`-style tokens from free-form prompt text. IO-free by design. */
export function parseFileReferences(content: string): ParsedFileReference[] {
  const refs: ParsedFileReference[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== "@" || !isReferenceBoundary(content[i - 1])) continue;
    const start = i;
    i += 1;
    if (i >= content.length) break;

    const quote = content[i];
    if (quote === '"' || quote === "'") {
      const parsed = readQuoted(content, i + 1, quote);
      if (!parsed) continue;
      refs.push({
        raw: `${quote}${parsed.raw}${quote}`,
        value: parsed.value,
        quoted: true,
        start,
        end: parsed.end + 1,
      });
      i = parsed.end;
      continue;
    }

    const parsed = readUnquoted(content, i);
    if (!parsed || parsed.value.length === 0) continue;
    refs.push({
      raw: parsed.raw,
      value: parsed.value,
      quoted: false,
      start,
      end: parsed.end,
    });
    i = parsed.end - 1;
  }
  return refs;
}

export function hasExpandedFileReferences(content: string): boolean {
  return content.includes(CONTEXT_MARKER);
}

export function stripExpandedFileReferences(content: string): string {
  return content
    .replace(
      /\n\n<aethon_file_references\b[\s\S]*?<\/aethon_file_references>/g,
      "",
    )
    .trimEnd();
}

/** Resolve prompt `@file` refs and append deterministic file context. */
export async function expandFileReferencesInPrompt(
  content: string,
  options: FileReferenceExpansionOptions,
): Promise<FileReferenceExpansion> {
  if (hasExpandedFileReferences(content)) {
    return { prompt: content, references: [] };
  }

  const parsed = parseFileReferences(content).filter((ref) =>
    shouldConsiderReference(ref, content, options.leadingSubagentName),
  );
  if (parsed.length === 0) return { prompt: content, references: [] };

  const root = resolve(options.cwd);
  const realRoot = await realpathOrSelf(root);
  const maxRefs = options.maxRefs ?? DEFAULT_MAX_REFS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const issues: string[] = [];
  const resolved: ResolvedReferenceTarget[] = [];
  for (const ref of parsed) {
    if (resolved.length >= maxRefs) {
      issues.push(`too many file references; maximum is ${maxRefs}`);
      break;
    }
    const target = await resolveReferenceTarget(ref, root, realRoot);
    if (target.kind === "ignore") continue;
    if (target.kind === "error") {
      issues.push(target.message);
      continue;
    }
    if (!resolved.some((item) => item.realPath === target.realPath)) {
      resolved.push(target);
    }
  }

  if (issues.length > 0) throw new FileReferenceError(issues);
  if (resolved.length === 0) return { prompt: content, references: [] };

  const references: ResolvedFileReference[] = [];
  let remainingTotal = maxTotalBytes;
  for (const target of resolved) {
    const stat = await fs.stat(target.path);
    const previewBytes = Math.max(
      0,
      Math.min(stat.size, maxFileBytes, remainingTotal),
    );
    const buffer = await readPreview(target.path, previewBytes);
    remainingTotal = Math.max(0, remainingTotal - buffer.length);
    const binary = isProbablyBinary(buffer);
    const contentText = binary ? "" : decodeUtf8(buffer);
    references.push({
      token: `@${target.ref.raw}`,
      requested: target.requested,
      path: target.path,
      displayPath: toDisplayPath(root, realRoot, target.path, target.realPath),
      sizeBytes: stat.size,
      content: contentText,
      truncated: stat.size > buffer.length,
      binary,
    });
  }

  return {
    prompt: `${content}${formatFileReferenceContext(root, references)}`,
    references,
  };
}

function isReferenceBoundary(prev: string | undefined): boolean {
  return prev === undefined || /\s/.test(prev) || "([{<'\"`".includes(prev);
}

function readQuoted(
  content: string,
  start: number,
  quote: string,
): { raw: string; value: string; end: number } | null {
  let raw = "";
  let value = "";
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "\\" && i + 1 < content.length) {
      raw += ch + content[i + 1];
      value += content[i + 1];
      i += 1;
      continue;
    }
    if (ch === quote) return { raw, value, end: i };
    raw += ch;
    value += ch;
  }
  return null;
}

function readUnquoted(
  content: string,
  start: number,
): { raw: string; value: string; end: number } | null {
  let raw = "";
  let value = "";
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (/\s/.test(ch)) return { raw, value, end: i };
    if (ch === "\\" && i + 1 < content.length) {
      raw += ch + content[i + 1];
      value += content[i + 1];
      i += 1;
      continue;
    }
    raw += ch;
    value += ch;
  }
  return { raw, value, end: content.length };
}

function shouldConsiderReference(
  ref: ParsedFileReference,
  content: string,
  leadingSubagentName: string | null | undefined,
): boolean {
  const mentionValue = stripReferencePunctuation(ref.value);
  if (
    leadingSubagentName &&
    mentionValue.toLowerCase() === leadingSubagentName.toLowerCase()
  ) {
    const trimmedStart = content.length - content.trimStart().length;
    if (ref.start === trimmedStart) return false;
  }
  return true;
}

type ResolvedReferenceTarget = {
  kind: "ok";
  ref: ParsedFileReference;
  requested: string;
  path: string;
  realPath: string;
};

type ResolveResult =
  | ResolvedReferenceTarget
  | { kind: "ignore" }
  | { kind: "error"; message: string };

async function resolveReferenceTarget(
  ref: ParsedFileReference,
  root: string,
  realRoot: string,
): Promise<ResolveResult> {
  const candidates = candidateValues(ref.value);
  const likely =
    ref.quoted || isLikelyPathReference(stripReferencePunctuation(ref.value));
  const errors: string[] = [];

  for (const requested of candidates) {
    const paths = candidatePaths(requested, root);
    for (const candidate of paths) {
      const resolved = resolve(candidate);
      if (!isInsidePath(root, resolved) && !requested.startsWith("/")) {
        errors.push(
          `${refLabel(ref)} resolves outside the project/worktree root`,
        );
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`${refLabel(ref)}: ${(err as Error).message}`);
        }
        continue;
      }
      const realPath = await fs.realpath(resolved);
      if (!isInsidePath(realRoot, realPath)) {
        return {
          kind: "error",
          message: `${refLabel(ref)} resolves outside the project/worktree root after resolving symlinks`,
        };
      }
      if (stat.isDirectory()) {
        return {
          kind: "error",
          message: `${refLabel(ref)} is a directory; reference explicit files instead`,
        };
      }
      if (!stat.isFile()) {
        return {
          kind: "error",
          message: `${refLabel(ref)} is not a regular file`,
        };
      }
      return { kind: "ok", ref, requested, path: resolved, realPath };
    }
    if (requested.startsWith("/")) {
      const absolute = resolve(requested);
      if (!isInsidePath(root, absolute) && (await exists(absolute))) {
        errors.push(
          `${refLabel(ref)} resolves outside the project/worktree root`,
        );
      }
    }
  }

  if (!likely) return { kind: "ignore" };
  const security = errors.find((msg) => msg.includes("outside"));
  return {
    kind: "error",
    message: security ?? `${refLabel(ref)} was not found under ${root}`,
  };
}

function stripReferencePunctuation(value: string): string {
  return value.replace(/[.,;:!?)}\]]+$/, "");
}

function candidateValues(value: string): string[] {
  const out = [value];
  let trimmed = value;
  while (/[.,;:!?\])}]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
    if (trimmed.length > 0) out.push(trimmed);
  }
  return [...new Set(out)];
}

function isLikelyPathReference(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(".")
  );
}

function candidatePaths(requested: string, root: string): string[] {
  if (!requested.startsWith("/")) return [resolve(root, requested)];

  // `@/Users/me/project/file` from drag/drop is an absolute path; `@/src/app.ts`
  // is a project-root-relative convenience. Prefer lexically in-root absolute
  // paths, otherwise try root-relative first but still allow a canonical
  // absolute path whose realpath lands inside a symlinked project root.
  const absolute = resolve(requested);
  const rootRelative = resolve(root, requested.slice(1));
  return isAbsolute(requested) && isInsidePath(root, absolute)
    ? [absolute, rootRelative]
    : [rootRelative, absolute];
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return path;
  }
}

async function readPreview(path: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  try {
    // `sample` may end in the middle of a multibyte code point when a large
    // text file is previewed. Streaming decode validates complete sequences
    // without treating an incomplete trailing character as binary data.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return false;
  } catch {
    return true;
  }
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function toDisplayPath(
  root: string,
  realRoot: string,
  path: string,
  realPath: string,
): string {
  const displayPath = isInsidePath(root, path) ? path : realPath;
  const displayRoot = isInsidePath(root, path) ? root : realRoot;
  const rel = relative(displayRoot, displayPath);
  return rel === "" ? "." : rel.split(sep).join("/");
}

function formatFileReferenceContext(
  root: string,
  references: ResolvedFileReference[],
): string {
  const parts = [
    "",
    "",
    `<aethon_file_references cwd=${JSON.stringify(root)}>`,
    "The user mentioned @file references. These files were resolved relative to the active project/worktree cwd and are provided as deterministic context.",
  ];
  for (const ref of references) {
    const attrs = [
      `path=${JSON.stringify(ref.displayPath)}`,
      `bytes=${JSON.stringify(ref.sizeBytes)}`,
      ref.truncated ? `truncated=${JSON.stringify(true)}` : "",
      ref.binary ? `binary=${JSON.stringify(true)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`<file ${attrs}>`);
    if (ref.binary) {
      parts.push(`[binary file omitted; ${ref.sizeBytes} bytes]`);
    } else if (ref.content.length === 0 && ref.truncated) {
      parts.push(
        "[file content omitted because the file-reference context size limit was reached]",
      );
    } else {
      parts.push(
        `${codeFenceFor(ref.content)}${languageForPath(ref.displayPath)}`,
      );
      parts.push(ref.content);
      parts.push(codeFenceFor(ref.content));
      if (ref.truncated) parts.push("[truncated]");
    }
    parts.push("</file>");
  }
  parts.push("</aethon_file_references>");
  return parts.join("\n");
}

function codeFenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function languageForPath(path: string): string {
  const ext = extname(path).replace(/^\./, "");
  if (!ext) return "";
  if (ext === "tsx") return "tsx";
  if (ext === "ts") return "ts";
  if (ext === "jsx") return "jsx";
  if (ext === "js") return "js";
  return ext;
}

function refLabel(ref: ParsedFileReference): string {
  return `@${ref.raw}`;
}
