import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  normalizeCanvasComponents,
  normalizeWindowState,
  syncNativeWindowsToState,
  terminalShellTabIds,
  type NativeCanvasWindowRecord,
} from "../../nativeWindows";
import { setPointer } from "../../utils/jsonPointer";
import {
  removeReservedShellTab,
  reserveShellTab,
  startReservedShell,
} from "./shellQuery";
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

const NATIVE_TERMINAL_READY_TIMEOUT_MS = 5_000;

function shellTabFromState(
  ctx: BridgeMessageContext,
  tabId: string,
): Record<string, unknown> | undefined {
  return ((ctx.stateRef.current.tabs as unknown[]) ?? []).find(
    (tab): tab is Record<string, unknown> =>
      Boolean(tab) &&
      typeof tab === "object" &&
      (tab as { id?: unknown }).id === tabId,
  );
}

async function waitForNativeCanvasReady(id: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    let cleanup: (() => void) | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (cleanup) cleanup();
      resolve();
    };
    const timer = setTimeout(finish, NATIVE_TERMINAL_READY_TIMEOUT_MS);
    listen<{ id?: string }>("native-canvas-window-ready", (event) => {
      if (event.payload?.id !== id) return;
      clearTimeout(timer);
      finish();
    })
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch(() => {
        clearTimeout(timer);
        finish();
      });
  });
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

async function cleanupOwnedTerminalShells(
  ctx: BridgeMessageContext,
  shellIds: string[],
): Promise<void> {
  if (shellIds.length === 0) return;
  await Promise.allSettled(
    shellIds.map((tabId) => invoke("shell_close", { tabId })),
  );
  const owned = new Set(shellIds);
  ctx.setState((prev) => {
    const tabs = (prev.tabs as unknown[] | undefined) ?? [];
    const panel =
      (prev.terminalPanel as { activeSubId?: string } | undefined) ?? {};
    return {
      ...prev,
      tabs: tabs.filter(
        (tab) =>
          !(
            tab &&
            typeof tab === "object" &&
            owned.has((tab as { id?: string }).id ?? "")
          ),
      ),
      ...(panel.activeSubId && owned.has(panel.activeSubId)
        ? { terminalPanel: { ...panel, activeSubId: "agent-bash" } }
        : {}),
    };
  });
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

    if (op === "open_terminal") {
      const requestedId =
        typeof args.id === "string" && args.id.trim()
          ? args.id.trim()
          : undefined;
      const previousRecord = requestedId
        ? (ctx.nativeWindowsRef.current.get(requestedId) ??
          (await invoke<NativeCanvasWindowRecord | null>(
            "native_window_get_canvas",
            { id: requestedId },
          )) ??
          undefined)
        : undefined;
      const shell = reserveShellTab(
        {
          ...args,
          tabId:
            typeof args.shellTabId === "string" && args.shellTabId.length > 0
              ? args.shellTabId
              : undefined,
          activate: args.activateShell === true,
        },
        ctx,
      );
      let openedRecordId: string | undefined;
      try {
        const shellTab = shellTabFromState(ctx, shell.tabId);
        const title =
          typeof args.title === "string" && args.title.trim()
            ? args.title
            : "Terminal";
        const input = {
          ...args,
          title,
          restoreOnLaunch: false,
          components: normalizeCanvasComponents([
            {
              id: "terminal",
              type: "shell-canvas",
              props: { tabId: shell.tabId, fontSize: args.fontSize ?? 13 },
            },
          ]),
          state: normalizeWindowState({
            ...asRecord(args.state),
            tabs: shellTab ? [shellTab] : [],
          }),
        };
        let record = await invoke<NativeCanvasWindowRecord>(
          "native_window_open_canvas",
          { input },
        );
        openedRecordId = record.id;
        ctx.nativeWindowsRef.current.set(record.id, record);
        syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);

        await waitForNativeCanvasReady(record.id);
        await startReservedShell(shell, ctx);

        const runningShellTab = shellTabFromState(ctx, shell.tabId);
        if (runningShellTab) {
          record = await persistRecord(ctx, {
            ...record,
            state: normalizeWindowState({
              ...asRecord(record.state),
              tabs: [runningShellTab],
            }),
          });
        }
        return record;
      } catch (err) {
        removeReservedShellTab(shell.tabId, ctx);
        await invoke("shell_close", { tabId: shell.tabId }).catch(() => {
          /* best-effort cleanup */
        });
        if (openedRecordId) {
          if (previousRecord && previousRecord.id === openedRecordId) {
            ctx.nativeWindowsRef.current.set(previousRecord.id, previousRecord);
            syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
            await persistRecord(ctx, previousRecord).catch(() => {
              /* best-effort restore */
            });
            await invoke("native_window_set_title", {
              id: previousRecord.id,
              title: previousRecord.title,
            }).catch(() => {
              /* best-effort restore */
            });
          } else {
            ctx.nativeWindowsRef.current.delete(openedRecordId);
            syncNativeWindowsToState(ctx.setState, ctx.nativeWindowsRef);
            await invoke("native_window_close", { id: openedRecordId }).catch(
              () => {
                /* best-effort cleanup */
              },
            );
          }
        }
        throw err;
      }
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
      const ownedShellIds = terminalShellTabIds(recordFromRef(ctx, id));
      await invoke("native_window_close", { id });
      await cleanupOwnedTerminalShells(ctx, ownedShellIds);
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
