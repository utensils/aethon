import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  const lastFrontendStateRef = useRef<Record<string, string>>({});
  const frontendPatchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unlisten = listen<string>("agent-reloaded", () => {
      // The fresh bridge lost its in-memory frontendState mirror. Clear
      // the local diff cache so the next state tick resends every watched
      // slice, even if the React value itself did not change.
      lastFrontendStateRef.current = {};
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (frontendPatchTimerRef.current !== null) {
      window.clearTimeout(frontendPatchTimerRef.current);
    }
    frontendPatchTimerRef.current = window.setTimeout(() => {
      frontendPatchTimerRef.current = null;
      // Snapshot the watched slices. Each entry maps a JSON-Pointer-like
      // path the bridge will store under to a value the frontend computes
      // from current state.
      const sidebar =
        (state.sidebar as Record<string, unknown> | undefined) ?? {};
      const tabs = (state.tabs as Tab[] | undefined) ?? [];
      const messagesCount =
        ((state.messages as unknown[] | undefined) ?? []).length;
      const slices: Record<string, unknown> = {
        "/sidebar/models": sidebar.models ?? [],
        "/sidebar/themes": sidebar.themes ?? [],
        "/connection": state.connection ?? "disconnected",
        "/status": state.status ?? "",
        "/draft": state.draft ?? "",
        "/messagesCount": messagesCount,
        "/tabs": tabs.map((t) => ({
          id: t.id,
          label: t.label,
          model: t.model ?? "",
          active: t.id === (state.activeTabId as string | undefined),
        })),
      };
      const last = lastFrontendStateRef.current;
      const next: Record<string, string> = { ...last };
      let changed = false;
      for (const [path, value] of Object.entries(slices)) {
        const serialized = JSON.stringify(value);
        if (last[path] === serialized) continue;
        next[path] = serialized;
        changed = true;
        // Fire-and-forget — bridge processes the patch and updates its
        // frontendState map. No ack needed; this is one-way mirroring.
        invoke("agent_command", {
          payload: JSON.stringify({
            type: "frontend_state_patch",
            path,
            value,
          }),
        }).catch(() => {
          // Bridge gone or webview reloaded mid-flight — fine, the next
          // patch will retry, and the bridge sees these as best-effort.
        });
      }
      if (changed) lastFrontendStateRef.current = next;
    }, 16);
    return () => {
      if (frontendPatchTimerRef.current !== null) {
        window.clearTimeout(frontendPatchTimerRef.current);
        frontendPatchTimerRef.current = null;
      }
    };
  }, [state]);
}
