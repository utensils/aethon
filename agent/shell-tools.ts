// Pi tool definitions wrapping `globalThis.aethon.shells.*` so the model
// can invoke shell sharing via the standard tool-use protocol (M6 P2.3).
//
// The aethon.shells API ships from agent/main.ts as a globalThis surface.
// Without these tool wrappers, the model would have to know to call
// `globalThis.aethon.shells.read({...})` from inside a `bash` tool — not
// discoverable via tool catalogs. With these registered, the model sees
// `listShells` / `readShell` / `writeShell` alongside built-in tools.
//
// Each tool is a thin shim: validate args, call the bridge API, return
// the result as a TextContent payload. The actual security boundary
// (share-mode gates + privacy floor) lives in shell.rs and is enforced
// regardless of how the API is reached.

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

interface ShellsApi {
  list(): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  read(args: {
    tabId: string;
    sinceTotal?: number;
    maxBytes?: number;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  write(args: {
    tabId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

function getShellsApi(): ShellsApi | null {
  const g = globalThis as { aethon?: { shells?: ShellsApi } };
  return g.aethon?.shells ?? null;
}

/** Throw on tool failure so pi sets `toolResult.isError = true` and the
 *  provider adapter renders a tool error. Returning a normal result
 *  with `errorMessage` looks succeeded to downstream consumers (pi
 *  only marks isError on throw — see `@mariozechner/pi-coding-agent`). */
function fail(message: string): never {
  throw new Error(message);
}

const ListParams = Type.Object({});
type ListParamsT = Static<typeof ListParams>;

const ReadParams = Type.Object({
  tabId: Type.String({
    description: "Shell tab id from listShells.",
  }),
  sinceTotal: Type.Optional(
    Type.Number({
      description:
        "Cursor returned by the previous read. Pass to resume forward; omit to get the latest maxBytes.",
    }),
  ),
  maxBytes: Type.Optional(
    Type.Number({
      description: "Cap on returned content size (default 8192, hard cap 65536).",
    }),
  ),
});
type ReadParamsT = Static<typeof ReadParams>;

const WriteParams = Type.Object({
  tabId: Type.String({
    description: "Shell tab id from listShells.",
  }),
  text: Type.String({
    description:
      "Keystrokes to inject. Include '\\n' to submit a command. Each call requires user approval in 'read-write' mode; 'read-write-trusted' skips the prompt.",
  }),
});
type WriteParamsT = Static<typeof WriteParams>;

export function buildShellTools(): ToolDefinition[] {
  const listTool = defineTool({
    name: "listShells",
    label: "List shells",
    description:
      "List shareable shell tabs (those whose share mode is read, read-write, or read-write-trusted). Returns metadata only — no scrollback. Use readShell for content.",
    promptSnippet:
      "listShells: list user shell tabs the user has shared with you",
    parameters: ListParams,
    async execute(
      _callId: string,
      _params: ListParamsT,
    ) {
      const api = getShellsApi();
      if (!api) fail("aethon.shells API unavailable");
      const r = await api.list();
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(r.data ?? [], null, 2),
          },
        ],
        details: r.data,
      };
    },
  }) as ToolDefinition;

  const readTool = defineTool({
    name: "readShell",
    label: "Read shell scrollback",
    description:
      "Return recent terminal output from a shareable shell tab. Forward-paging from sinceTotal; cold-start (no cursor) returns the latest maxBytes. Refuses tabs whose share mode is 'private'.",
    promptSnippet:
      "readShell: stream a user shell's recent output (gated by share mode)",
    parameters: ReadParams,
    async execute(
      _callId: string,
      params: ReadParamsT,
    ) {
      const api = getShellsApi();
      if (!api) fail("aethon.shells API unavailable");
      const r = await api.read({
        tabId: params.tabId,
        ...(params.sinceTotal !== undefined ? { sinceTotal: params.sinceTotal } : {}),
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
      if (!r.ok) fail(r.error ?? "unknown");
      const data = (r.data ?? {}) as {
        content?: string;
        totalAppended?: number;
        shareFloor?: number;
        shareMode?: string;
      };
      // Surface the paging cursor in the *visible* tool text — model
      // providers don't forward `details` to the LLM, so a cursor that
      // only lives in details is invisible at the next turn. The model
      // re-uses `totalAppended` as the next call's `sinceTotal` to walk
      // the stream forward.
      const meta = `[shell ${data.shareMode ?? "?"} · totalAppended=${data.totalAppended ?? 0} · shareFloor=${data.shareFloor ?? 0}]`;
      const body = data.content ?? "";
      return {
        content: [
          { type: "text" as const, text: body.length > 0 ? `${meta}\n${body}` : meta },
        ],
        details: data,
      };
    },
  }) as ToolDefinition;

  const writeTool = defineTool({
    name: "writeShell",
    label: "Write to shell",
    description:
      "Inject keystrokes into a shareable shell tab. Each call requires user approval in 'read-write' mode (the user sees an Allow/Deny prompt); 'read-write-trusted' skips the prompt. Refuses tabs whose share mode is 'private' or 'read'. Include '\\n' in `text` to submit a command.",
    promptSnippet:
      "writeShell: drive a user shell (gated by user confirmation in read-write mode)",
    parameters: WriteParams,
    async execute(
      _callId: string,
      params: WriteParamsT,
    ) {
      const api = getShellsApi();
      if (!api) fail("aethon.shells API unavailable");
      const r = await api.write({ tabId: params.tabId, text: params.text });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: r.data ?? null,
      };
    },
  }) as ToolDefinition;

  return [listTool, readTool, writeTool];
}
