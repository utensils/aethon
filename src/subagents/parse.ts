/**
 * Frontend mirror of the agent-side subagent parser, plus a serializer for the
 * editor. The agent bridge ({@link ../../agent/subagents/parse.ts}) and this
 * module must agree on the markdown+frontmatter contract — kept in lockstep by
 * convention (same as `src/auth-profiles` mirrors `agent/auth-profiles`).
 *
 * The UI works at the file level: it reads raw content from `subagents_list`,
 * parses it for display, and serializes the editor form back to a file written
 * via `subagents_write`. Rust never parses the markdown, so the contract lives
 * in one language.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MAX_AGENT_TIMEOUT_SECONDS } from "../config";

export type SubagentScope = "user" | "project";
export type SubagentSurface = "inline" | "tab";

/** Parsed definition fields (name comes from the filename, not the body). */
export interface SubagentFields {
  description: string;
  /** `provider/model-id`; empty/undefined inherits the tab's model. */
  model?: string;
  /** undefined = inherit all tools; [] = none; [...] = allowlist. */
  tools?: string[];
  surface: SubagentSurface;
  /** Inline run timeout override, in seconds. Undefined uses global config. */
  timeoutSeconds?: number;
  systemPrompt: string;
}

/** A raw file as returned by the `subagents_list` Tauri command. */
export interface SubagentFile {
  scope: SubagentScope;
  name: string;
  filePath: string;
  content: string;
}

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSafeSubagentName(input: string): boolean {
  return SAFE_NAME_RE.test(input);
}

export function sanitizeSubagentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

const BOM = 0xfeff;
const FRONTMATTER_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export interface ParseSubagentResult {
  fields?: SubagentFields;
  error?: string;
}

export function parseSubagentContent(raw: string): ParseSubagentResult {
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
    return { error: "frontmatter `description` is required" };
  }
  const model =
    typeof fields.model === "string" && fields.model.trim()
      ? fields.model.trim()
      : undefined;
  const timeoutSeconds = parseTimeoutField(fields.timeout);
  if (timeoutSeconds.error) return { error: timeoutSeconds.error };

  return {
    fields: {
      description,
      model,
      tools: parseToolsField(fields.tools),
      surface: fields.surface === "tab" ? "tab" : "inline",
      timeoutSeconds: timeoutSeconds.value,
      systemPrompt: body.trim(),
    },
  };
}

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

function parseTimeoutField(value: unknown): {
  value?: number;
  error?: string;
} {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string" && value.trim()) {
    return parseTimeoutField(Number(value));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return {
      error: "frontmatter `timeout` must be a positive number of seconds",
    };
  }
  return {
    value: Math.min(Math.max(Math.floor(value), 1), MAX_AGENT_TIMEOUT_SECONDS),
  };
}

/** Serialize editor fields back to a markdown+frontmatter file body. Default
 *  fields (inline surface, inherited tools) are omitted to keep files clean. */
export function serializeSubagent(fields: SubagentFields): string {
  const frontmatter: Record<string, unknown> = {
    description: fields.description.trim(),
  };
  if (fields.model?.trim()) frontmatter.model = fields.model.trim();
  if (fields.tools !== undefined) frontmatter.tools = fields.tools;
  if (fields.surface === "tab") frontmatter.surface = "tab";
  if (fields.timeoutSeconds !== undefined) {
    frontmatter.timeout = fields.timeoutSeconds;
  }
  const yaml = stringifyYaml(frontmatter).trimEnd();
  const body = fields.systemPrompt.trim();
  return `---\n${yaml}\n---\n${body ? `${body}\n` : ""}`;
}
