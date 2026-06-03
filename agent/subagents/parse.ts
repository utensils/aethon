/**
 * Pure parsing + validation for subagent markdown definitions.
 *
 * No IO — given a raw file body and its context (path, scope, name), produce
 * either a {@link Subagent} or a human-readable error. The loader ({@link
 * ./loader}) supplies the canonical name (the file stem) and records errors as
 * {@link SubagentLoadIssue}s.
 */

import { parse as parseYaml } from "yaml";
import type { Subagent, SubagentScope, SubagentSurface } from "./types";

/** Canonical name shape: lower-case, `[a-z0-9_-]`, must start alphanumeric,
 *  ≤64 chars. Mirrors the auth-profile id guard so file/registry/disk stay in
 *  lockstep. */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSafeSubagentName(input: string): boolean {
  return SAFE_NAME_RE.test(input);
}

/** Best-effort slug for a user-supplied name (used by the editor before a
 *  write). Returns "" when nothing usable remains, which callers reject. */
export function sanitizeSubagentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

export interface ParseSubagentResult {
  subagent?: Subagent;
  error?: string;
}

/** Unicode BOM code point — stripped before frontmatter detection. */
const BOM = 0xfeff;

/** Frontmatter block: a leading `---` line, the YAML body, a closing `---`
 *  line, then the markdown body. Tolerant of CRLF line endings. */
const FRONTMATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export function parseSubagentMarkdown(
  raw: string,
  ctx: { filePath: string; scope: SubagentScope; name: string },
): ParseSubagentResult {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { error: "missing YAML frontmatter (expected a leading --- block)" };
  }
  const [, frontmatterText, body] = match;

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterText);
  } catch (err) {
    return { error: `invalid YAML frontmatter: ${(err as Error).message}` };
  }
  if (
    !frontmatter ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    return { error: "frontmatter must be a YAML mapping" };
  }
  const fields = frontmatter as Record<string, unknown>;

  const description =
    typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) {
    return {
      error:
        "frontmatter `description` is required (it drives auto-delegation)",
    };
  }

  const model =
    typeof fields.model === "string" && fields.model.trim()
      ? fields.model.trim()
      : undefined;

  return {
    subagent: {
      name: ctx.name,
      description,
      model,
      tools: parseToolsField(fields.tools),
      surface: parseSurfaceField(fields.surface),
      systemPrompt: body.trim(),
      scope: ctx.scope,
      filePath: ctx.filePath,
    },
  };
}

/**
 * Normalize the `tools` frontmatter into the three meaningful states:
 *  - absent / wrong-type  → `undefined`  (inherit the full toolset)
 *  - empty list or string → `[]`         (reasoning only, no tools)
 *  - non-empty            → allowlist (deduped, order-preserved)
 *
 * Accepts both YAML list form (`[a, b]` / block list) and a comma/space
 * separated string (`a, b`), matching common subagent conventions.
 */
function parseToolsField(value: unknown): string[] | undefined {
  let tokens: string[];
  if (Array.isArray(value)) {
    tokens = value.map((v) => (typeof v === "string" ? v : String(v)));
  } else if (typeof value === "string") {
    tokens = value.split(/[,\s]+/);
  } else {
    return undefined;
  }
  const tools = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  return [...new Set(tools)];
}

function parseSurfaceField(value: unknown): SubagentSurface {
  return value === "tab" ? "tab" : "inline";
}

/**
 * Map a subagent's tool allowlist onto pi's `createAgentSession` options.
 *  - inherit (undefined) → `{}` (pi enables its default toolset)
 *  - none (`[]`)         → `{ noTools: "all" }`
 *  - allowlist           → `{ tools: [...] }`
 */
export function resolveSubagentTools(sub: Pick<Subagent, "tools">): {
  tools?: string[];
  noTools?: "all" | "builtin";
} {
  if (sub.tools === undefined) return {};
  if (sub.tools.length === 0) return { noTools: "all" };
  return { tools: sub.tools };
}
