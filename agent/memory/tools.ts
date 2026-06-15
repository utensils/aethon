import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { AethonAgentState } from "../state";
import { readMemoryPath, resolveMemoryContext, resolveMemoryScope } from "./resolver";
import { forgetMemoryEntry, readMemoryFile, rememberEntry } from "./store";
import type { MemoryScopeName, RememberInput } from "./types";

const Scope = Type.Union([Type.Literal("user"), Type.Literal("project")]);

const EmptyParams = Type.Object({});
type EmptyParamsT = Static<typeof EmptyParams>;

const ReadParams = Type.Object({
  scope: Scope,
});
type ReadParamsT = { scope: MemoryScopeName };

const RememberParams = Type.Object({
  scope: Scope,
  kind: Type.Union([
    Type.Literal("instruction"),
    Type.Literal("preference"),
    Type.Literal("fact"),
    Type.Literal("workflow"),
    Type.Literal("pitfall"),
  ]),
  text: Type.String({
    description: "Durable memory text to store. Do not include secrets, credentials, tokens, or temporary one-off context.",
  }),
  tags: Type.Optional(Type.Array(Type.String())),
});
type RememberParamsT = RememberInput & { scope: MemoryScopeName };

const ForgetParams = Type.Object({
  scope: Scope,
  id: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
});
type ForgetParamsT = { scope: MemoryScopeName; id?: string; text?: string };

function cwdForTab(state: AethonAgentState, tabId: string): string {
  return state.tabProjectCwds.get(tabId) ?? state.currentProjectCwd ?? state.userDir ?? process.cwd();
}

function asJson(value: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function hasSecretShape(text: string): boolean {
  return /(api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]/i.test(text) ||
    /(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}/.test(text);
}

async function scopeFor(state: AethonAgentState, tabId: string, scope: MemoryScopeName) {
  return resolveMemoryScope({ userDir: state.userDir, cwd: cwdForTab(state, tabId), scope });
}

export function buildMemoryTools(state: AethonAgentState, tabId: string): ToolDefinition[] {
  const listTool = defineTool({
    name: "listMemoryScopes",
    label: "List Aethon memory scopes",
    description:
      "List the Aethon user and resolved-project memory scopes for the active tab, including file paths and project/worktree resolution metadata.",
    promptSnippet:
      "listMemoryScopes: inspect Aethon's user/project memory files and current project/worktree resolution",
    parameters: EmptyParams,
    async execute(_callId: string, _params: EmptyParamsT) {
      const ctx = await resolveMemoryContext({ userDir: state.userDir, cwd: cwdForTab(state, tabId) });
      return asJson({ user: ctx.user, project: ctx.project });
    },
  }) as ToolDefinition;

  const readTool = defineTool({
    name: "readMemory",
    label: "Read Aethon memory",
    description:
      "Read the Aethon MEMORY.md file for the selected scope. Use this before editing memory when you need to inspect existing entries.",
    promptSnippet: "readMemory: read Aethon's user or resolved-project MEMORY.md",
    parameters: ReadParams,
    async execute(_callId: string, params: ReadParamsT) {
      const scope = await scopeFor(state, tabId, params.scope);
      const text = await readMemoryFile(scope);
      return { content: [{ type: "text" as const, text }], details: { scope, text } };
    },
  }) as ToolDefinition;

  const rememberTool = defineTool({
    name: "remember",
    label: "Remember in Aethon memory",
    description:
      "Persist a durable user or project memory under ~/.aethon. Call this when the user explicitly says things like 'remember ...', 'Always ...', 'Never ...', or 'from now on ...'. Use scope='user' for global personal preferences and scope='project' for codebase/workflow facts. Do not store secrets, credentials, sensitive personal data, or temporary one-off context; ask first if scope or durability is ambiguous.",
    promptSnippet:
      "remember: persist explicit durable memory. Use when the user says 'remember', 'Always ...', 'Never ...', or 'from now on ...'; never store secrets.",
    parameters: RememberParams,
    async execute(_callId: string, params: RememberParamsT) {
      if (hasSecretShape(params.text)) {
        throw new Error("Refusing to store likely secret or credential-shaped memory.");
      }
      const scope = await scopeFor(state, tabId, params.scope);
      return asJson(await rememberEntry(scope, params));
    },
  }) as ToolDefinition;

  const forgetTool = defineTool({
    name: "forgetMemory",
    label: "Forget Aethon memory",
    description:
      "Remove a memory entry from the selected Aethon scope by id or exact text. Use when the user asks you to forget or delete a stored memory.",
    promptSnippet:
      "forgetMemory: delete an Aethon memory entry by id or exact text when the user asks to forget it",
    parameters: ForgetParams,
    async execute(_callId: string, params: ForgetParamsT) {
      if (!params.id && !params.text) {
        throw new Error("forgetMemory requires id or text");
      }
      const scope = await scopeFor(state, tabId, params.scope);
      return asJson(await forgetMemoryEntry(scope, { id: params.id, text: params.text }));
    },
  }) as ToolDefinition;

  return [listTool, readTool, rememberTool, forgetTool];
}

export async function formatMemorySummary(state: AethonAgentState, tabId: string): Promise<string> {
  const ctx = await resolveMemoryContext({ userDir: state.userDir, cwd: cwdForTab(state, tabId) });
  const userMemory = readMemoryPath(ctx.user.memoryPath).trim() || "(empty)";
  const projectMemory = readMemoryPath(ctx.project.memoryPath).trim() || "(empty)";
  const lines = ["## Aethon memory"];
  lines.push("Aethon memory is stored locally under `~/.aethon/memory` and is separate from repository `AGENTS.md` files.");
  lines.push("", "### User scope", `- File: ${ctx.user.memoryPath}`, "", userMemory);
  lines.push("", "### Project scope", `- File: ${ctx.project.memoryPath}`);
  if (ctx.project.project) {
    lines.push(`- Resolved project: ${ctx.project.project.label} (${ctx.project.project.root})`);
    lines.push(`- Source: ${ctx.project.project.source}`);
  }
  lines.push("", projectMemory);
  return lines.join("\n");
}
