const MAX_IMAGES_PER_RESULT = 4;

export interface ToolFileChange {
  kind: "edited" | "created";
  path: string;
  rootPath?: string;
  preview?: string;
  additions?: number;
  deletions?: number;
}

function firstLine(value: unknown, max = 180): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const newline = trimmed.search(/\r?\n/);
  const line = newline >= 0 ? trimmed.slice(0, newline) : trimmed;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function baseName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? value;
}

function compactSummary(parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

/** Render a one-line summary of tool args so the card description shows
 *  what the tool was actually invoked with, not just `{...}`. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "read":
      return [
        a.path,
        a.startLine && `lines ${a.startLine}-${a.endLine ?? "end"}`,
      ]
        .filter(Boolean)
        .join(" ");
    case "bash":
      return (
        String(a.command ?? "")
          .split("\n")[0]
          ?.slice(0, 200) ?? ""
      );
    case "edit":
    case "write":
      return String(a.path ?? "");
    case "grep":
      return `${a.pattern ?? ""}${a.path ? ` in ${a.path}` : ""}`;
    case "find":
      return String(a.pattern ?? a.path ?? "");
    case "ls":
      return String(a.path ?? ".");
    case "task":
      return compactSummary([
        String(a.subagent_type ?? "subagent"),
        firstLine(a.prompt),
      ]);
    case "task_batch": {
      const tasks = Array.isArray(a.tasks) ? a.tasks : [];
      const names = tasks
        .map((item) =>
          item && typeof item === "object"
            ? String((item as Record<string, unknown>).subagent_type ?? "")
            : "",
        )
        .filter(Boolean)
        .join(", ");
      return compactSummary([
        names || "subagents",
        String(a.surface ?? "inline"),
      ]);
    }
    case "subagent":
      return compactSummary([String(a.agent ?? "agent"), firstLine(a.task)]);
    case "startTask":
      return compactSummary([baseName(a.projectPath), firstLine(a.prompt)]);
    default: {
      const json = JSON.stringify(args);
      return json.length > 200 ? json.slice(0, 197) + "…" : json;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function countDiffStats(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function writeLooksCreated(text: string): boolean {
  return /\b(created|new file|wrote new|created file)\b/i.test(text);
}

function fileChangeForTool(opts: {
  toolName: string;
  args?: unknown;
  result?: unknown;
  rootPath?: string;
}): ToolFileChange | undefined {
  if (opts.toolName !== "edit" && opts.toolName !== "write") return undefined;
  const path = stringArg(opts.args, "path");
  if (!path) return undefined;
  const extracted =
    opts.result !== undefined ? extractToolContent(opts.result) : undefined;
  const preview = extracted?.text ? truncate(extracted.text, 4000) : undefined;
  const stats = preview ? countDiffStats(preview) : undefined;
  const kind =
    opts.toolName === "write" && preview && writeLooksCreated(preview)
      ? "created"
      : "edited";
  return {
    kind,
    path,
    ...(opts.rootPath ? { rootPath: opts.rootPath } : {}),
    ...(preview ? { preview } : {}),
    ...(stats && stats.additions > 0 ? { additions: stats.additions } : {}),
    ...(stats && stats.deletions > 0 ? { deletions: stats.deletions } : {}),
  };
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  cts: "typescript",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  hs: "haskell",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonl: "json",
  jsx: "jsx",
  kt: "kotlin",
  lua: "lua",
  mjs: "javascript",
  mts: "typescript",
  nix: "nix",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
};

function languageFromPath(path: string): string | undefined {
  const clean = path.trim().replace(/^["'`]|["'`]$/g, "");
  const base = clean.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base.endsWith(".dockerfile"))
    return "dockerfile";
  if (base === "makefile") return "make";
  const ext = /\.([a-z0-9]+)$/.exec(base)?.[1];
  return ext ? EXTENSION_LANGUAGES[ext] : undefined;
}

export function inferToolResultLanguage(
  toolName: string,
  argsSummary: string,
  text: string,
): string {
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const pathLang = languageFromPath(argsSummary.split(/\s+/)[0] ?? "");
    if (pathLang) return pathLang;
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith("diff --git ") || trimmed.startsWith("--- "))
    return "diff";
  return "text";
}

interface ExtractedImage {
  data: string;
  mimeType: string;
}
interface ExtractedResult {
  text: string;
  images: ExtractedImage[];
}

/** Pi tool results: walk the content array, pull text for the code-block
 *  child and image data for any `image` primitives. */
export function extractToolContent(result: unknown): ExtractedResult {
  const empty: ExtractedResult = { text: "", images: [] };
  if (result === null || result === undefined) return empty;
  if (typeof result === "string") return { text: result, images: [] };
  if (typeof result !== "object") {
    return { text: String(result), images: [] };
  }
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const texts: string[] = [];
    const images: ExtractedImage[] = [];
    for (const p of obj.content) {
      if (!p || typeof p !== "object") continue;
      const part = p as {
        type?: string;
        text?: string;
        data?: string;
        mimeType?: string;
      };
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      } else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        if (images.length < MAX_IMAGES_PER_RESULT) {
          images.push({ data: part.data, mimeType: part.mimeType });
        }
      }
    }
    if (texts.length > 0 || images.length > 0) {
      return { text: texts.join("\n"), images };
    }
  }
  if (typeof obj.text === "string") return { text: obj.text, images: [] };
  try {
    return { text: JSON.stringify(result, null, 2), images: [] };
  } catch {
    return { text: String(result), images: [] };
  }
}

/** Build the A2UI payload for a tool-call card.
 *
 *  The frontend `ToolCard` composite derives the running/done/failed
 *  state from the `startedAt` and `endedAt` props (running iff
 *  `startedAt !== undefined && endedAt === undefined`), so callers
 *  signal "still running" by passing `startedAt` only — no separate
 *  `running` flag is needed in the wire payload. */
export function toolCardPayload(opts: {
  id: string;
  toolName: string;
  argsSummary: string;
  args?: unknown;
  rootPath?: string;
  fileChange?: ToolFileChange;
  result?: unknown;
  isError?: boolean;
  status?: "cancelled";
  startedAt?: number;
  endedAt?: number;
}) {
  const {
    id,
    toolName,
    argsSummary,
    args,
    rootPath,
    fileChange,
    result,
    isError,
    status,
    startedAt,
    endedAt,
  } = opts;
  const children: unknown[] = [];
  const toolFileChange =
    fileChange ?? fileChangeForTool({ toolName, args, result, rootPath });
  if (result !== undefined) {
    const extracted = extractToolContent(result);
    if (extracted.text) {
      if (toolName === "task" || toolName === "task_batch") {
        children.push({
          id: `${id}-result`,
          type: "subagent-result",
          props: {
            content: truncate(extracted.text, 3000),
            ...(isError ? { isError: true } : {}),
          },
        });
      } else {
        children.push({
          id: `${id}-result`,
          type: "code",
          props: {
            content: truncate(extracted.text, 1500),
            language: inferToolResultLanguage(
              toolName,
              argsSummary,
              extracted.text,
            ),
          },
        });
      }
    }
    extracted.images.forEach((img, i) => {
      children.push({
        id: `${id}-image-${i}`,
        type: "image",
        props: {
          src: `data:${img.mimeType};base64,${img.data}`,
          alt: `${toolName} image ${i + 1}`,
        },
      });
    });
  }
  return {
    components: [
      {
        id,
        type: "tool-card",
        props: {
          title: toolName,
          toolName,
          description: argsSummary || undefined,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(isError ? { isError: true } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(toolFileChange ? { fileChange: toolFileChange } : {}),
        },
        children,
      },
    ],
  };
}
