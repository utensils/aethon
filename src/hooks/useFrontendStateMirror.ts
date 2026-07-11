import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeUnlisten } from "../utils/safeUnlisten";
import type { ScheduledTaskRecord } from "../scheduledTasks";
import type { Tab } from "../types/tab";

export interface UseFrontendStateMirrorContext {
  /** Live state object — passed (not via ref) so the effect re-runs on
   *  every state change. */
  state: Record<string, unknown>;
}

/**
 * Mirror an allowlisted set of frontend state slices back to the bridge
 * so extensions can introspect them via `aethon.getFrontendState(path)`.
 * The bridge can otherwise only see values it wrote itself — this closes
 * the loop on frontend-populated keys (model picker, themes, connection,
 * status, tabs, draft, messages count). Debounced via a microtask + diff
 * so a flurry of state changes (typing into the composer) coalesces into
 * a single ack-bearing patch per slice.
 *
 * Per-frame coalesce timer. Each state change reschedules; the IPC
 * burst only fires once the user stops mutating state for a tick. This
 * matters most when typing into the composer — without the debounce,
 * every keystroke fires a /draft patch (one IPC per character).
 */
export function useFrontendStateMirror(
  ctx: UseFrontendStateMirrorContext,
): void {
  const { state } = ctx;
  const stateRef = useRef(state);
  const lastFrontendStateRef = useRef<Record<string, string>>({});
  const lastControlSnapshotRef = useRef<string>("");
  const frontendPatchTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const retryAttemptsRef = useRef<Record<string, number>>({});
  const retryValuesRef = useRef<Record<string, string>>({});
  const flushRef = useRef<() => void>(() => {});
  const scheduleFlushRef = useRef<(delay?: number) => void>(() => {});

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    scheduleFlushRef.current = (delay = 16) => {
      if (!mountedRef.current) return;
      if (frontendPatchTimerRef.current !== null) {
        window.clearTimeout(frontendPatchTimerRef.current);
      }
      frontendPatchTimerRef.current = window.setTimeout(() => {
        frontendPatchTimerRef.current = null;
        flushRef.current();
      }, delay);
    };

    flushRef.current = () => {
      const currentState = stateRef.current;
      // Snapshot the watched slices. Each entry maps a JSON-Pointer-like
      // path the bridge will store under to a value the frontend computes
      // from current state.
      const sidebar =
        (currentState.sidebar as Record<string, unknown> | undefined) ?? {};
      const tabs = (currentState.tabs as Tab[] | undefined) ?? [];
      const messagesCount = (
        (currentState.messages as unknown[] | undefined) ?? []
      ).length;
      const scheduledTasks =
        (
          currentState.scheduledTasks as
            | { tasks?: ScheduledTaskRecord[] }
            | undefined
        )?.tasks ?? [];
      const slices: Record<string, unknown> = {
        "/sidebar/models": sidebar.models ?? [],
        "/sidebar/themes": sidebar.themes ?? [],
        "/connection": currentState.connection ?? "disconnected",
        "/status": currentState.status ?? "",
        "/draft": currentState.draft ?? "",
        "/messagesCount": messagesCount,
        "/nativeWindows": currentState.nativeWindows ?? [],
        "/extensionFrontendModules":
          currentState.extensionFrontendModules ?? [],
        "/scheduledTasks": scheduledTasks.map((task) => ({
          id: task.id,
          label: task.label,
          mode: task.mode,
          status: task.status,
          nextRunAt: task.nextRunAt ?? null,
          lastRunAt: task.lastRunAt ?? null,
          lastCompletedAt: task.lastCompletedAt ?? null,
          expiresAt: task.expiresAt,
          runCount: task.runCount,
          coalescedMisses: task.coalescedMisses,
          lastError: task.lastError ?? null,
        })),
        "/tabs": tabs.map((t) => ({
          id: t.id,
          label: t.label,
          kind: t.kind,
          cwd: t.cwd,
          model: t.model ?? "",
          waiting: t.waiting === true,
          authProfileId: t.authProfileId,
          active: t.id === (currentState.activeTabId as string | undefined),
        })),
      };
      const controlSnapshot = {
        location: typeof window !== "undefined" ? window.location.href : null,
        status: currentState.status ?? "",
        connection: currentState.connection ?? "disconnected",
        waiting: currentState.waiting === true,
        theme:
          typeof document !== "undefined"
            ? (document.documentElement.dataset.theme ?? "")
            : "",
        model: currentState.model ?? "",
        activeTabId: currentState.activeTabId ?? null,
        authProfiles: currentState.authProfiles ?? { profiles: [] },
        models: sidebar.models ?? [],
        tabs: slices["/tabs"],
      };
      const controlSerialized = JSON.stringify(controlSnapshot);
      if (controlSerialized !== lastControlSnapshotRef.current) {
        invoke("control_update_state", { snapshot: controlSnapshot })
          .then(() => {
            // A newer snapshot may have been sent while this request was in
            // flight. Only cache the value if it is still the desired one.
            const latest = stateRef.current;
            if (latest === currentState) {
              lastControlSnapshotRef.current = controlSerialized;
            }
          })
          .catch(() => scheduleFlushRef.current(100));
      }
      for (const [path, value] of Object.entries(slices)) {
        const serialized = JSON.stringify(value);
        if (lastFrontendStateRef.current[path] === serialized) continue;
        if (retryValuesRef.current[path] !== serialized) {
          retryValuesRef.current[path] = serialized;
          retryAttemptsRef.current[path] = 0;
        }
        invoke("agent_command", {
          payload: JSON.stringify({
            type: "frontend_state_patch",
            path,
            value,
          }),
        })
          .then(() => {
            if (retryValuesRef.current[path] !== serialized) return;
            lastFrontendStateRef.current[path] = serialized;
            retryAttemptsRef.current[path] = 0;
          })
          .catch(() => {
            if (retryValuesRef.current[path] !== serialized) return;
            const attempts = (retryAttemptsRef.current[path] ?? 0) + 1;
            retryAttemptsRef.current[path] = attempts;
            if (attempts <= 3) {
              scheduleFlushRef.current(100 * 2 ** (attempts - 1));
            }
          });
      }
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("agent-reloaded", () => {
      // The fresh bridge lost its in-memory frontendState mirror. Clear
      // the local diff cache so the next state tick resends every watched
      // slice, even if the React value itself did not change.
      lastFrontendStateRef.current = {};
      lastControlSnapshotRef.current = "";
      retryAttemptsRef.current = {};
      retryValuesRef.current = {};
      // Reload is itself the state transition. React may not render again,
      // so actively restore the fresh bridge's mirror from the latest state.
      if (frontendPatchTimerRef.current !== null) {
        window.clearTimeout(frontendPatchTimerRef.current);
        frontendPatchTimerRef.current = null;
      }
      flushRef.current();
    });
    return () => {
      void unlisten.then(safeUnlisten).catch(() => {});
    };
  }, []);

  useEffect(() => {
    scheduleFlushRef.current();
  }, [state]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frontendPatchTimerRef.current !== null) {
        window.clearTimeout(frontendPatchTimerRef.current);
        frontendPatchTimerRef.current = null;
      }
    };
  }, []);
}
