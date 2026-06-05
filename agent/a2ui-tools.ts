// Pi tool definitions wrapping the live Aethon A2UI runtime API so the
// model can mutate the UI through the standard tool-use protocol.

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

interface MutationResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

interface CanvasApi {
  emit(components: unknown): Promise<MutationResult>;
  append(components: unknown): Promise<MutationResult>;
  patch(path: string, value: unknown): Promise<MutationResult>;
  clear(): Promise<MutationResult>;
}

interface A2uiApi {
  getFrontendState(path?: string): unknown;
  getLayout(): unknown;
  setState(path: string, value: unknown): Promise<MutationResult>;
  patchLayout(path: string, value: unknown): Promise<MutationResult>;
  setLayout(payload: unknown): Promise<MutationResult>;
  canvas: CanvasApi;
}

function getA2uiApi(): A2uiApi | null {
  const g = globalThis as { aethon?: Partial<A2uiApi> };
  const api = g.aethon;
  const canvas = api?.canvas as Partial<CanvasApi> | undefined;
  if (
    !api ||
    typeof api.getFrontendState !== "function" ||
    typeof api.getLayout !== "function" ||
    typeof api.setState !== "function" ||
    typeof api.patchLayout !== "function" ||
    typeof api.setLayout !== "function" ||
    !canvas ||
    typeof canvas.emit !== "function" ||
    typeof canvas.append !== "function" ||
    typeof canvas.patch !== "function" ||
    typeof canvas.clear !== "function"
  ) {
    return null;
  }
  return api as A2uiApi;
}

function fail(message: string): never {
  throw new Error(message);
}

function apiOrFail(): A2uiApi {
  const api = getA2uiApi();
  if (!api) fail("aethon A2UI API unavailable");
  return api;
}

function resultOrThrow(r: MutationResult): MutationResult {
  if (!r.ok) fail(r.error ?? "unknown");
  return r;
}

function asJson(value: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
    details: value ?? null,
  };
}

const EmptyParams = Type.Object({});
const OptionalPathParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Optional JSON Pointer path to read from the frontend mirror. Omit to return all mirrored slices.",
    }),
  ),
});
const PathValueParams = Type.Object({
  path: Type.String({
    description: "JSON Pointer path to write, e.g. /status or /canvas.",
  }),
  value: Type.Any({
    description: "JSON-serializable value to store at path.",
  }),
});
const LayoutPayloadParams = Type.Object({
  payload: Type.Any({
    description: "A2UI layout payload with a top-level components array.",
  }),
});
const CanvasComponentsParams = Type.Object({
  components: Type.Any({
    description:
      "A2UI component or array of components to place in the live canvas.",
  }),
});
const CanvasPatchParams = Type.Object({
  path: Type.String({
    description:
      "Subpath under /canvas to patch, e.g. /components/0/props/title.",
  }),
  value: Type.Any({
    description: "JSON-serializable value to store at the canvas subpath.",
  }),
});

type EmptyParamsT = Static<typeof EmptyParams>;
type OptionalPathParamsT = Static<typeof OptionalPathParams>;
type PathValueParamsT = { path: string; value: unknown };
type LayoutPayloadParamsT = { payload: unknown };
type CanvasComponentsParamsT = { components: unknown };
type CanvasPatchParamsT = { path: string; value: unknown };

export function buildA2uiTools(): ToolDefinition[] {
  const getStateTool = defineTool({
    name: "getA2uiState",
    label: "Get A2UI state",
    description:
      "Read frontend-mirrored A2UI state. Pass a JSON Pointer path like /tabs or /status, or omit path for all mirrored slices.",
    promptSnippet: "getA2uiState: inspect live frontend state before UI mutation",
    parameters: OptionalPathParams,
    execute(_callId: string, params: OptionalPathParamsT) {
      const api = apiOrFail();
      return asJson(api.getFrontendState(params.path));
    },
  }) as ToolDefinition;

  const getLayoutTool = defineTool({
    name: "getA2uiLayout",
    label: "Get A2UI layout",
    description:
      "Return the active A2UI layout payload so you can inspect it before patching.",
    promptSnippet: "getA2uiLayout: inspect the active A2UI layout tree",
    parameters: EmptyParams,
    execute(_callId: string, _params: EmptyParamsT) {
      const api = apiOrFail();
      return asJson(api.getLayout());
    },
  }) as ToolDefinition;

  const setStateTool = defineTool({
    name: "setA2uiState",
    label: "Set A2UI state",
    description:
      "Mutate frontend layout state at a JSON Pointer path. Bound A2UI components rerender immediately.",
    promptSnippet: "setA2uiState: write live A2UI state",
    parameters: PathValueParams,
    async execute(_callId: string, params: PathValueParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.setState(params.path, params.value));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const patchLayoutTool = defineTool({
    name: "patchA2uiLayout",
    label: "Patch A2UI layout",
    description:
      "Patch the active A2UI layout at a JSON Pointer path, preserving arrays.",
    promptSnippet: "patchA2uiLayout: patch the active A2UI layout tree",
    parameters: PathValueParams,
    async execute(_callId: string, params: PathValueParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.patchLayout(params.path, params.value));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const setLayoutTool = defineTool({
    name: "setA2uiLayout",
    label: "Set A2UI layout",
    description:
      "Replace the active A2UI layout payload. Use with care; payload must include components[].",
    promptSnippet: "setA2uiLayout: replace the active A2UI layout",
    parameters: LayoutPayloadParams,
    async execute(_callId: string, params: LayoutPayloadParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.setLayout(params.payload));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const emitCanvasTool = defineTool({
    name: "emitA2uiCanvas",
    label: "Emit A2UI canvas",
    description:
      "Replace the live canvas with an A2UI component or component array.",
    promptSnippet: "emitA2uiCanvas: replace the live canvas",
    parameters: CanvasComponentsParams,
    async execute(_callId: string, params: CanvasComponentsParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.canvas.emit(params.components));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const appendCanvasTool = defineTool({
    name: "appendA2uiCanvas",
    label: "Append A2UI canvas",
    description:
      "Append an A2UI component or component array to the live canvas.",
    promptSnippet: "appendA2uiCanvas: append to the live canvas",
    parameters: CanvasComponentsParams,
    async execute(_callId: string, params: CanvasComponentsParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.canvas.append(params.components));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const patchCanvasTool = defineTool({
    name: "patchA2uiCanvas",
    label: "Patch A2UI canvas",
    description:
      "Patch a subpath under /canvas, e.g. /components/0/props/title.",
    promptSnippet: "patchA2uiCanvas: patch a live canvas subpath",
    parameters: CanvasPatchParams,
    async execute(_callId: string, params: CanvasPatchParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.canvas.patch(params.path, params.value));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const clearCanvasTool = defineTool({
    name: "clearA2uiCanvas",
    label: "Clear A2UI canvas",
    description: "Clear the live canvas.",
    promptSnippet: "clearA2uiCanvas: clear the live canvas",
    parameters: EmptyParams,
    async execute(_callId: string, _params: EmptyParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.canvas.clear());
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  return [
    getStateTool,
    getLayoutTool,
    setStateTool,
    patchLayoutTool,
    setLayoutTool,
    emitCanvasTool,
    appendCanvasTool,
    patchCanvasTool,
    clearCanvasTool,
  ];
}
