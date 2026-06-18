// Pi tool definitions for Aethon's native A2UI canvas windows.

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

interface MutationResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

interface WindowsApi {
  openCanvas(input?: Record<string, unknown>): Promise<MutationResult>;
  list(): Promise<MutationResult>;
  focus(id: string): Promise<MutationResult>;
  close(id: string): Promise<MutationResult>;
  setTitle(id: string, title: string): Promise<MutationResult>;
  emitCanvas(id: string, components: unknown): Promise<MutationResult>;
  appendCanvas(id: string, components: unknown): Promise<MutationResult>;
  patchCanvas(
    id: string,
    path: string,
    value: unknown,
  ): Promise<MutationResult>;
  clearCanvas(id: string): Promise<MutationResult>;
  setState(id: string, path: string, value: unknown): Promise<MutationResult>;
}

interface AethonWindowsApi {
  windows: WindowsApi;
}

function getWindowsApi(): AethonWindowsApi | null {
  const api = (globalThis as { aethon?: Partial<AethonWindowsApi> }).aethon;
  const windows = api?.windows as Partial<WindowsApi> | undefined;
  if (
    !api ||
    !windows ||
    typeof windows.openCanvas !== "function" ||
    typeof windows.list !== "function" ||
    typeof windows.focus !== "function" ||
    typeof windows.close !== "function" ||
    typeof windows.setTitle !== "function" ||
    typeof windows.emitCanvas !== "function" ||
    typeof windows.appendCanvas !== "function" ||
    typeof windows.patchCanvas !== "function" ||
    typeof windows.clearCanvas !== "function" ||
    typeof windows.setState !== "function"
  ) {
    return null;
  }
  return api as AethonWindowsApi;
}

function fail(message: string): never {
  throw new Error(message);
}

function apiOrFail(): AethonWindowsApi {
  const api = getWindowsApi();
  if (!api) fail("aethon windows API unavailable");
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
const OpenCanvasWindowParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Optional stable id. Must match /^[A-Za-z][\\w-]*$/. Omit to generate one.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Native window title." })),
  components: Type.Optional(
    Type.Any({
      description:
        "A2UI component or array of components to render in the window.",
    }),
  ),
  state: Type.Optional(
    Type.Any({ description: "Initial window-local JSON Pointer state." }),
  ),
  width: Type.Optional(Type.Number({ description: "Initial logical width." })),
  height: Type.Optional(
    Type.Number({ description: "Initial logical height." }),
  ),
  x: Type.Optional(Type.Number({ description: "Initial logical x position." })),
  y: Type.Optional(Type.Number({ description: "Initial logical y position." })),
  focus: Type.Optional(
    Type.Boolean({ description: "Whether to focus the window after opening." }),
  ),
  restoreOnLaunch: Type.Optional(
    Type.Boolean({
      description:
        "Defaults true. False creates a one-off window that is not restored on launch.",
    }),
  ),
});
const IdParams = Type.Object({
  id: Type.String({ description: "Native canvas window id." }),
});
const TitleParams = Type.Object({
  id: Type.String({ description: "Native canvas window id." }),
  title: Type.String({ description: "New native window title." }),
});
const WindowComponentsParams = Type.Object({
  id: Type.String({ description: "Native canvas window id." }),
  components: Type.Any({
    description:
      "A2UI component or array of components to place in the window canvas.",
  }),
});
const WindowPatchParams = Type.Object({
  id: Type.String({ description: "Native canvas window id." }),
  path: Type.String({
    description:
      "JSON Pointer path under the window canvas payload, e.g. /components/0/props/title.",
  }),
  value: Type.Any({ description: "JSON-serializable value to write." }),
});
const WindowStateParams = Type.Object({
  id: Type.String({ description: "Native canvas window id." }),
  path: Type.String({
    description: "JSON Pointer path in the window-local state.",
  }),
  value: Type.Any({ description: "JSON-serializable value to write." }),
});

type EmptyParamsT = Static<typeof EmptyParams>;
type OpenCanvasWindowParamsT = Static<typeof OpenCanvasWindowParams>;
type IdParamsT = Static<typeof IdParams>;
type TitleParamsT = Static<typeof TitleParams>;
type WindowComponentsParamsT = Static<typeof WindowComponentsParams>;
type WindowPatchParamsT = Static<typeof WindowPatchParams>;
type WindowStateParamsT = Static<typeof WindowStateParams>;

export function buildWindowTools(): ToolDefinition[] {
  const openTool = defineTool({
    name: "openA2uiCanvasWindow",
    label: "Open A2UI window",
    description:
      "Open or focus a native OS window that renders bare A2UI canvas content without replacing Aethon's main layout.",
    promptSnippet:
      "openA2uiCanvasWindow: create an isolated native A2UI canvas window",
    parameters: OpenCanvasWindowParams,
    async execute(_callId: string, params: OpenCanvasWindowParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(await api.windows.openCanvas(params));
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const listTool = defineTool({
    name: "listA2uiCanvasWindows",
    label: "List A2UI windows",
    description: "List open native A2UI canvas windows.",
    promptSnippet: "listA2uiCanvasWindows: inspect open A2UI canvas windows",
    parameters: EmptyParams,
    async execute(_callId: string, _params: EmptyParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(await api.windows.list());
      return asJson(r.data ?? []);
    },
  }) as ToolDefinition;

  const focusTool = defineTool({
    name: "focusA2uiCanvasWindow",
    label: "Focus A2UI window",
    description: "Focus an open native A2UI canvas window.",
    promptSnippet: "focusA2uiCanvasWindow: bring an A2UI window forward",
    parameters: IdParams,
    async execute(_callId: string, params: IdParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.windows.focus(params.id));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const closeTool = defineTool({
    name: "closeA2uiCanvasWindow",
    label: "Close A2UI window",
    description:
      "Close a native A2UI canvas window and remove it from restore records.",
    promptSnippet: "closeA2uiCanvasWindow: close an A2UI canvas window",
    parameters: IdParams,
    async execute(_callId: string, params: IdParamsT) {
      const api = apiOrFail();
      resultOrThrow(await api.windows.close(params.id));
      return asJson({ ok: true });
    },
  }) as ToolDefinition;

  const titleTool = defineTool({
    name: "setA2uiCanvasWindowTitle",
    label: "Title A2UI window",
    description: "Set the native title of an open A2UI canvas window.",
    promptSnippet: "setA2uiCanvasWindowTitle: rename an A2UI canvas window",
    parameters: TitleParams,
    async execute(_callId: string, params: TitleParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(
        await api.windows.setTitle(params.id, params.title),
      );
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const emitTool = defineTool({
    name: "emitA2uiWindowCanvas",
    label: "Emit window canvas",
    description: "Replace a native window's A2UI canvas content.",
    promptSnippet: "emitA2uiWindowCanvas: replace a window canvas",
    parameters: WindowComponentsParams,
    async execute(_callId: string, params: WindowComponentsParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(
        await api.windows.emitCanvas(params.id, params.components),
      );
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const appendTool = defineTool({
    name: "appendA2uiWindowCanvas",
    label: "Append window canvas",
    description: "Append A2UI content to a native window's canvas.",
    promptSnippet: "appendA2uiWindowCanvas: append to a window canvas",
    parameters: WindowComponentsParams,
    async execute(_callId: string, params: WindowComponentsParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(
        await api.windows.appendCanvas(params.id, params.components),
      );
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const patchTool = defineTool({
    name: "patchA2uiWindowCanvas",
    label: "Patch window canvas",
    description:
      "Patch a JSON Pointer path under a native window's A2UI canvas.",
    promptSnippet: "patchA2uiWindowCanvas: patch a window canvas path",
    parameters: WindowPatchParams,
    async execute(_callId: string, params: WindowPatchParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(
        await api.windows.patchCanvas(params.id, params.path, params.value),
      );
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const clearTool = defineTool({
    name: "clearA2uiWindowCanvas",
    label: "Clear window canvas",
    description: "Clear a native window's A2UI canvas.",
    promptSnippet: "clearA2uiWindowCanvas: clear a window canvas",
    parameters: IdParams,
    async execute(_callId: string, params: IdParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(await api.windows.clearCanvas(params.id));
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  const stateTool = defineTool({
    name: "setA2uiWindowState",
    label: "Set window state",
    description:
      "Set window-local JSON Pointer state for a native A2UI canvas window.",
    promptSnippet: "setA2uiWindowState: mutate window-local A2UI state",
    parameters: WindowStateParams,
    async execute(_callId: string, params: WindowStateParamsT) {
      const api = apiOrFail();
      const r = resultOrThrow(
        await api.windows.setState(params.id, params.path, params.value),
      );
      return asJson(r.data ?? { ok: true });
    },
  }) as ToolDefinition;

  return [
    openTool,
    listTool,
    focusTool,
    closeTool,
    titleTool,
    emitTool,
    appendTool,
    patchTool,
    clearTool,
    stateTool,
  ];
}
