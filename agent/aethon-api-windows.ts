/**
 * Builder for the `aethon.windows` sub-API.
 *
 * Native canvas windows are owned by the frontend/Rust side, so every method
 * travels through the same mutation-ack query channel used by shells/editor.
 */

import type {
  AethonAgentState,
  MutationResult,
  NativeCanvasWindowSummary,
} from "./state";
import type { WindowsApi } from "./aethon-api";
import { awaitFrontendReady, trackMutation } from "./mutation-ack";
import { frontendActiveTabId } from "./state-mutation";

export interface WindowsApiDeps {
  send: (obj: Record<string, unknown>) => void;
}

const MUTATION_ACK_TIMEOUT_MS_DEFAULT = 5_000;
const WINDOW_LONG_ACK_TIMEOUT_MS = 30_000;

type NativeWindowOp =
  | "open_canvas"
  | "list"
  | "focus"
  | "close"
  | "set_title"
  | "emit_canvas"
  | "append_canvas"
  | "patch_canvas"
  | "clear_canvas"
  | "set_state";

function ownerTabId(state: AethonAgentState): string {
  return (
    state.tabContext.getStore() ??
    state.currentAgentTabId ??
    frontendActiveTabId(state) ??
    "default"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeWindow(value: unknown): NativeCanvasWindowSummary | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const label = value.label;
  const kind = value.kind;
  const title = value.title;
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    kind !== "canvas" ||
    typeof title !== "string"
  ) {
    return null;
  }
  const components = Array.isArray(value.components) ? value.components : [];
  return {
    id,
    label,
    kind: "canvas",
    title,
    ...(typeof value.tabId === "string" ? { tabId: value.tabId } : {}),
    ...(typeof value.restoreOnLaunch === "boolean"
      ? { restoreOnLaunch: value.restoreOnLaunch }
      : {}),
    componentCount: components.length,
  };
}

function updateKnownWindows(
  state: AethonAgentState,
  data: unknown,
  op: NativeWindowOp,
  args: Record<string, unknown>,
): void {
  if (op === "close" && typeof args.id === "string") {
    state.nativeWindows.delete(args.id);
    return;
  }

  if (isRecord(data) && Array.isArray(data.windows)) {
    state.nativeWindows.clear();
    for (const item of data.windows) {
      const summary = summarizeWindow(item);
      if (summary) state.nativeWindows.set(summary.id, summary);
    }
    return;
  }

  const summary = summarizeWindow(data);
  if (summary) state.nativeWindows.set(summary.id, summary);
}

export function buildWindowsApi(
  state: AethonAgentState,
  deps: WindowsApiDeps,
): WindowsApi {
  async function windowQuery(
    op: NativeWindowOp,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<MutationResult> {
    const ready = await awaitFrontendReady(
      state,
      MUTATION_ACK_TIMEOUT_MS_DEFAULT,
    );
    if (!ready) return { ok: false, error: "frontend_not_ready" };
    const { id, promise } = trackMutation(state, timeoutMs);
    deps.send({ type: "native_window_query", mutationId: id, op, args });
    const result = await promise;
    if (result.ok) updateKnownWindows(state, result.data, op, args);
    return result;
  }

  const idRequired = (id: unknown): id is string =>
    typeof id === "string" && id.trim().length > 0;

  return {
    openCanvas(input = {}) {
      const args =
        input && typeof input === "object"
          ? { ...(input as Record<string, unknown>) }
          : {};
      if (typeof args.tabId !== "string") args.tabId = ownerTabId(state);
      return windowQuery("open_canvas", args, WINDOW_LONG_ACK_TIMEOUT_MS);
    },
    list() {
      return windowQuery("list");
    },
    focus(id) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      return windowQuery("focus", { id });
    },
    close(id) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      return windowQuery("close", { id });
    },
    setTitle(id, title) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      if (typeof title !== "string" || !title.trim()) {
        return Promise.resolve({ ok: false, error: "title required" });
      }
      return windowQuery("set_title", { id, title });
    },
    emitCanvas(id, components) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      return windowQuery("emit_canvas", { id, components });
    },
    appendCanvas(id, components) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      return windowQuery("append_canvas", { id, components });
    },
    patchCanvas(id, path, value) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      if (typeof path !== "string" || !path) {
        return Promise.resolve({ ok: false, error: "path required" });
      }
      return windowQuery("patch_canvas", { id, path, value });
    },
    clearCanvas(id) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      return windowQuery("clear_canvas", { id });
    },
    setState(id, path, value) {
      if (!idRequired(id)) {
        return Promise.resolve({ ok: false, error: "id required" });
      }
      if (typeof path !== "string" || !path) {
        return Promise.resolve({ ok: false, error: "path required" });
      }
      return windowQuery("set_state", { id, path, value });
    },
  };
}
