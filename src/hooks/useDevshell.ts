/**
 * useDevshell — keep `/devshell` state in sync with Tauri devshell
 * events and mirror them to the agent so its bash-tool spawnHook
 * cache stays warm.
 *
 * The hook owns three things:
 *
 *  - **Tauri listener.** Subscribes to `devshell-resolving` /
 *    `devshell-ready` / `devshell-failed` and writes a per-root entry
 *    into `state.devshell.entries[root]`. The status-bar chip reads
 *    from that slice.
 *  - **Agent push.** When an event lands, we also forward it through
 *    `agent_command` as a `devshell_event` message. The agent's
 *    `onDevshellEvent` handler invalidates its local cache so the
 *    next bash spawnHook call re-fetches the freshly-resolved env.
 *  - **First-paint hydration.** When the active project changes, the
 *    hook calls `devshell_status` once so the chip can render
 *    immediately (no waiting for the first resolver round-trip).
 */

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DevshellEntry {
  kind: string | null;
  detectedKind: string | null;
  enabled: "auto" | "always" | "never" | string;
  mode: "auto" | "direnv" | "nix" | "nix-shell" | string;
  state: "none" | "idle" | "resolving" | "ready" | "failed";
  resolvedAtMs?: number;
  durationMs?: number;
  varCount?: number;
  reason?: string;
}

export interface UseDevshellOptions {
  /** Active project path (cwd of the active tab). Hook re-queries
   *  status whenever this changes so the badge updates on project
   *  switch. */
  activeRoot: string | null;
  /** Patch into `/devshell` slice of central state. The hook passes
   *  *partial* updates here (Tauri push events don't carry enabled /
   *  mode); the callback should merge over the existing entry so
   *  config-derived fields like `enabled` / `mode` aren't clobbered
   *  with stale defaults on every resolver event. */
  setDevshellEntry: (root: string, patch: Partial<DevshellEntry>) => void;
  setDevshellActive: (root: string | null) => void;
}

interface ResolvingPayload {
  root: string;
  kind: string;
}

interface ReadyPayload {
  root: string;
  kind: string;
  resolvedAtMs: number;
  durationMs: number;
  varCount: number;
}

interface FailedPayload {
  root: string;
  kind: string;
  reason: string;
  failedAtMs: number;
}

interface StatusResponse {
  enabled: string;
  mode: string;
  detectedKind: string | null;
  snapshot:
    | { state: "none" }
    | { state: "idle"; kind: string }
    | { state: "resolving"; kind: string; started_at_ms: number }
    | {
        state: "ready";
        kind: string;
        resolved_at_ms: number;
        duration_ms: number;
        var_count: number;
      }
    | { state: "failed"; kind: string; reason: string; failed_at_ms: number };
}

const FORWARD_TO_AGENT = true;

export function useDevshell(opts: UseDevshellOptions): void {
  // Mirror the options object into a ref *inside* an effect so the
  // ref write doesn't run during render (which the react-hooks/refs
  // lint rule disallows).
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Mirror active root into the central store so the chip can read
  // /devshell/activeRoot to know which entry to display.
  useEffect(() => {
    optsRef.current.setDevshellActive(opts.activeRoot);
  }, [opts.activeRoot]);

  // Hydrate on activeRoot change. Best-effort — failures are silently
  // swallowed (the chip just won't render until a resolver event lands).
  useEffect(() => {
    if (!opts.activeRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await invoke<StatusResponse>("devshell_status", {
          args: { root: opts.activeRoot },
        });
        if (cancelled) return;
        const entry = entryFromStatus(result);
        if (entry && opts.activeRoot) {
          optsRef.current.setDevshellEntry(opts.activeRoot, entry);
        }
      } catch {
        // Outside Tauri (vitest) — silent no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opts.activeRoot]);

  // Tauri event listener. One subscription for life of the hook.
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    const hydrateRootStatus = async (root: string) => {
      try {
        const result = await invoke<StatusResponse>("devshell_status", {
          args: { root },
        });
        const entry = entryFromStatus(result);
        if (entry) {
          optsRef.current.setDevshellEntry(root, entry);
        }
      } catch {
        // Lifecycle events already updated state; config metadata
        // hydration is best-effort.
      }
    };
    void (async () => {
      try {
        // Push events carry only what the resolver knows (kind +
        // state + timings/reason). We deliberately do NOT set
        // `enabled` / `mode` here — those come from the user's
        // config and are populated by the initial `devshell_status`
        // hydration call above. The setter merges patches over the
        // existing entry so config-derived fields survive every
        // resolver event.
        const offResolving = await listen<ResolvingPayload>(
          "devshell-resolving",
          (event) => {
            const { root, kind } = event.payload;
            optsRef.current.setDevshellEntry(root, {
              kind,
              detectedKind: kind,
              state: "resolving",
            });
            void hydrateRootStatus(root);
            forwardToAgent(root, kind, "resolving");
          },
        );
        const offReady = await listen<ReadyPayload>("devshell-ready", (event) => {
          const { root, kind, resolvedAtMs, durationMs, varCount } = event.payload;
          optsRef.current.setDevshellEntry(root, {
            kind,
            detectedKind: kind,
            state: "ready",
            resolvedAtMs,
            durationMs,
            varCount,
          });
          void hydrateRootStatus(root);
          forwardToAgent(root, kind, "ready");
        });
        const offFailed = await listen<FailedPayload>("devshell-failed", (event) => {
          const { root, kind, reason } = event.payload;
          optsRef.current.setDevshellEntry(root, {
            kind,
            detectedKind: kind,
            state: "failed",
            reason,
          });
          void hydrateRootStatus(root);
          forwardToAgent(root, kind, "failed");
        });
        if (cancelled) {
          safeUnlisten(offResolving);
          safeUnlisten(offReady);
          safeUnlisten(offFailed);
          return;
        }
        unlisteners = [offResolving, offReady, offFailed];
      } catch {
        // Running outside Tauri (vitest / plain browser).
      }
    })();
    return () => {
      cancelled = true;
      for (const fn of unlisteners) safeUnlisten(fn);
    };
  }, []);
}

function safeUnlisten(fn: UnlistenFn): void {
  try {
    fn();
  } catch {
    // Tauri can already have dropped listener ids during webview reload or
    // app shutdown. Cleanup is best-effort; avoid surfacing teardown noise.
  }
}

function entryFromStatus(s: StatusResponse): DevshellEntry | null {
  const enabled = s.enabled;
  const mode = s.mode;
  const detectedKind = s.detectedKind;
  switch (s.snapshot.state) {
    case "none":
      // Surface `enabled = never` distinctly so the chip can render
      // "off" rather than nothing.
      if (enabled === "never" && detectedKind) {
        return {
          kind: detectedKind,
          detectedKind,
          enabled,
          mode,
          state: "none",
        };
      }
      if (detectedKind) {
        // Detected but not yet resolving. Chip can render "ready to wrap".
        return {
          kind: detectedKind,
          detectedKind,
          enabled,
          mode,
          state: "idle",
        };
      }
      return null;
    case "idle":
      return {
        kind: detectedKind,
        detectedKind,
        enabled,
        mode,
        state: "idle",
      };
    case "resolving":
      return {
        kind: s.snapshot.kind,
        detectedKind,
        enabled,
        mode,
        state: "resolving",
      };
    case "ready":
      return {
        kind: s.snapshot.kind,
        detectedKind,
        enabled,
        mode,
        state: "ready",
        resolvedAtMs: s.snapshot.resolved_at_ms,
        durationMs: s.snapshot.duration_ms,
        varCount: s.snapshot.var_count,
      };
    case "failed":
      return {
        kind: s.snapshot.kind,
        detectedKind,
        enabled,
        mode,
        state: "failed",
        reason: s.snapshot.reason,
      };
  }
}

function forwardToAgent(
  root: string,
  kind: string,
  status: "resolving" | "ready" | "failed",
): void {
  if (!FORWARD_TO_AGENT) return;
  // Fire-and-forget; the agent treats missing events as cache misses
  // and self-recovers via getCachedEnv's background fetch.
  void invoke("agent_command", {
    payload: JSON.stringify({
      type: "devshell_event",
      devshellRoot: root,
      devshellKind: kind,
      devshellStatus: status,
    }),
  }).catch(() => {
    /* agent not booted yet — ignore */
  });
}

/** Manually trigger a refresh for `root`. Settings → Devshell "Refresh
 *  now" button reaches here. Returns a Promise so callers can disable
 *  the button while in-flight. */
export async function refreshDevshell(root: string): Promise<void> {
  await invoke("devshell_refresh", { args: { root } });
}
