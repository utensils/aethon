import { invoke } from "@tauri-apps/api/core";
import {
  normalizeCanvasComponents,
  normalizeWindowState,
  syncNativeWindowsToState,
  type NativeCanvasWindowRecord,
} from "../../nativeWindows";
import { setPointer } from "../../utils/jsonPointer";
import type { BridgeMessageHandler, BridgeMessageContext } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePointer(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("path required");
  }
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function requireId(args: Record<string, unknown>): string {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("id required");
  return id;
}

function recordFromRef(
  ctx: BridgeMessageContext,
  id: string,
): NativeCanvasWindowRecord | undefined {
  return ctx.nativeWindowsRef.current.get(id);
}

async function getRecord(
  ctx: BridgeMessageContext,
  id: string,
): Promise<NativeCanvasWindowRecord> {
  const cached = recordFromRef(ctx, id);
  if (cached) return cached;
  const record = await invoke<NativeCanvasWindowRecord | null>(
    "native_window_get_canvas",
    { id },
  );
  if (!record) throw new Error(`window not found: ${id}`);
  ctx.nativeWindowsRef.current.set(record.id, record);
  syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
  return record;
}

async function persistRecord(
  ctx: BridgeMessageContext,
  record: NativeCanvasWindowRecord,
): Promise<NativeCanvasWindowRecord> {
  const saved = await invoke<NativeCanvasWindowRecord>(
    "native_window_save_canvas",
    {
      record,
    },
  );
  ctx.nativeWindowsRef.current.set(saved.id, saved);
  syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
  return saved;
}

function replaceRecords(
  ctx: BridgeMessageContext,
  records: NativeCanvasWindowRecord[],
): void {
  ctx.nativeWindowsRef.current = new Map(
    records.map((record) => [record.id, record]),
  );
  syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
}

export const handleNativeWindowQuery: BridgeMessageHandler = (data, ctx) => {
  const op = data.op as string | undefined;
  const args = asRecord(data.args);
  const mid = data.mutationId;

  const route = async (): Promise<unknown> => {
    if (op === "open_canvas") {
      const input = {
        ...args,
        components: normalizeCanvasComponents(args.components),
        state: normalizeWindowState(args.state),
      };
      const record = await invoke<NativeCanvasWindowRecord>(
        "native_window_open_canvas",
        { input },
      );
      ctx.nativeWindowsRef.current.set(record.id, record);
      syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
      return record;
    }

    if (op === "list") {
      const records =
        await invoke<NativeCanvasWindowRecord[]>("native_window_list");
      replaceRecords(ctx, records);
      return records;
    }

    if (op === "get") {
      return await getRecord(ctx, requireId(args));
    }

    if (op === "get_state") {
      return (await getRecord(ctx, requireId(args))).state ?? {};
    }

    if (op === "get_canvas") {
      return { components: (await getRecord(ctx, requireId(args))).components };
    }

    if (op === "focus") {
      await invoke("native_window_focus", { id: requireId(args) });
      return { ok: true };
    }

    if (op === "close") {
      const id = requireId(args);
      await invoke("native_window_close", { id });
      ctx.nativeWindowsRef.current.delete(id);
      syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
      return { ok: true };
    }

    if (op === "set_title") {
      const id = requireId(args);
      const title = typeof args.title === "string" ? args.title : "";
      if (!title.trim()) throw new Error("title required");
      const record = await invoke<NativeCanvasWindowRecord>(
        "native_window_set_title",
        { id, title },
      );
      ctx.nativeWindowsRef.current.set(record.id, record);
      syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
      return record;
    }

    if (op === "emit_canvas") {
      const id = requireId(args);
      const record = await getRecord(ctx, id);
      return await persistRecord(ctx, {
        ...record,
        components: normalizeCanvasComponents(args.components),
      });
    }

    if (op === "append_canvas") {
      const id = requireId(args);
      const record = await getRecord(ctx, id);
      const additions = normalizeCanvasComponents(args.components);
      if (additions.length === 0) return record;
      return await persistRecord(ctx, {
        ...record,
        components: [...record.components, ...additions],
      });
    }

    if (op === "patch_canvas") {
      const id = requireId(args);
      const record = await getRecord(ctx, id);
      const path = normalizePointer(args.path);
      const canvasPath = path.startsWith("/components")
        ? path.slice("/components".length) || "/"
        : path;
      const patchedComponents = setPointer(
        record.components,
        canvasPath,
        args.value,
      );
      return await persistRecord(ctx, {
        ...record,
        components: normalizeCanvasComponents(patchedComponents),
      });
    }

    if (op === "clear_canvas") {
      const id = requireId(args);
      const record = await getRecord(ctx, id);
      return await persistRecord(ctx, { ...record, components: [] });
    }

    if (op === "set_state") {
      const id = requireId(args);
      const record = await getRecord(ctx, id);
      const path = normalizePointer(args.path);
      return await persistRecord(ctx, {
        ...record,
        state: setPointer(record.state ?? {}, path, args.value),
      });
    }

    throw new Error(`unknown native_window_query op: ${op}`);
  };

  route()
    .then((result) => ctx.ackMutation(mid, true, undefined, result))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(mid, false, msg);
    });
};
