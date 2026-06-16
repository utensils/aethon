// Pi tool definition wrapping `globalThis.aethon.editor.openFile` so the
// model can open files in the Monaco editor through normal tool use.

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

interface MutationResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

interface EditorApi {
  openFile(args: {
    path: string;
    rootPath?: string;
  }): Promise<MutationResult>;
}

function getEditorApi(): EditorApi | null {
  const g = globalThis as { aethon?: { editor?: EditorApi } };
  return g.aethon?.editor ?? null;
}

function fail(message: string): never {
  throw new Error(message);
}

const OpenFileParams = Type.Object({
  path: Type.String({
    description:
      "File path to open in Monaco. Relative paths resolve against this tab's working directory; absolute paths must stay inside that root unless rootPath is provided.",
  }),
  rootPath: Type.Optional(
    Type.String({
      description:
        "Optional absolute root to resolve/validate path against instead of the active tab working directory.",
    }),
  ),
});
type OpenFileParamsT = Static<typeof OpenFileParams>;

export function buildEditorTools(): ToolDefinition[] {
  const openFileTool = defineTool({
    name: "openFileInEditor",
    label: "Open file in editor",
    description:
      "Open or focus a file in Aethon's Monaco editor. Use this when the user asks to open a file for them. Relative paths resolve against the active tab cwd.",
    promptSnippet:
      "openFileInEditor: open or focus a file in the Monaco editor",
    parameters: OpenFileParams,
    async execute(_callId: string, params: OpenFileParamsT) {
      const api = getEditorApi();
      if (!api) fail("aethon.editor API unavailable");
      const r = await api.openFile({
        path: params.path,
        ...(typeof params.rootPath === "string" ? { rootPath: params.rootPath } : {}),
      });
      if (!r.ok) fail(r.error ?? "unknown");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(r.data ?? {}, null, 2) },
        ],
        details: r.data ?? null,
      };
    },
  }) as ToolDefinition;

  return [openFileTool];
}
