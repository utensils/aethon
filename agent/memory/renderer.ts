import type { ResolvedMemoryContext } from "./types";

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 25 * 1024;

function capText(
  text: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let truncated = false;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let next = lines.slice(0, maxLines).join("\n");
  if (lines.length > maxLines) truncated = true;

  const bytes = Buffer.byteLength(next, "utf8");
  if (bytes > maxBytes) {
    truncated = true;
    next = Buffer.from(next, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  return { text: next.trim(), truncated };
}

export function renderMemoryPromptSection(ctx: ResolvedMemoryContext): string {
  const maxLines = ctx.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = ctx.maxBytes ?? DEFAULT_MAX_BYTES;
  const user = capText(ctx.userMemory, maxLines, maxBytes);
  const project = capText(ctx.projectMemory, maxLines, maxBytes);
  if (!user.text && !project.text) return "";

  const lines: string[] = ["# Aethon memory"];
  lines.push(
    "These are persistent user/project memories stored under `~/.aethon`. Treat them as durable guidance, but do not store secrets. If the user explicitly asks you to remember, always do, never do, or from now on do something, use the memory tools to update the appropriate scope.",
  );

  if (user.text) {
    lines.push("", `## User memory (${ctx.user.memoryPath})`, user.text);
    if (user.truncated) lines.push("(User memory truncated for prompt budget.)");
  }

  if (project.text) {
    lines.push("", `## Project memory (${ctx.project.memoryPath})`);
    const p = ctx.project.project;
    if (p) {
      lines.push(
        `Resolved project: \`${p.label}\` at \`${p.root}\` (scope source: \`${p.source}\`, current cwd: \`${p.resolvedFromCwd}\`).`,
      );
    }
    lines.push(project.text);
    if (project.truncated) {
      lines.push("(Project memory truncated for prompt budget.)");
    }
  }

  return lines.join("\n");
}
