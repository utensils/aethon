/**
 * Extension state writes — `aethon.setState(path, value)`. This is the
 * highest-volume mutation channel: setIntervals from extensions, agent
 * setStates during a turn, and direct calls from event handlers all
 * land here.
 *
 * Three concerns wrap the actual write:
 *
 *   1. **Size guards.** A 180 MB write blocks the Node event loop on
 *      pipe backpressure and freezes the bridge. Hard cap rejects with
 *      a notice; soft warn logs (rate-limited per extension+path).
 *   2. **Tab attribution.** Priority: explicit `sourceTabId` → ALS store
 *      from `tabContext` → currently running prompt's `currentAgentTabId`.
 *   3. **Per-tab mirroring.** Top-level keys `messages` / `draft` /
 *      `waiting` / `queueCount` / `canvas` / `model` are mirrored into
 *      a per-tab map so a webview reload's `ready` can replay each tab's
 *      UI state without smearing one tab's writes into another.
 */

import type { AethonAgentState, MutationResult } from "./state";
import { trackMutation } from "./mutation-ack";
import { setAtPointer } from "./jsonPointer";
import {
  makeCanvasApi as buildCanvasApi,
  readCanvasComponentsFromTabState,
  type CanvasApi,
} from "./canvas";
import {
  makeExtStateLogLimiter,
  type RateLimiter,
} from "./state-limits";
import { logger } from "./logger";

/** Rolling window for setState size-guard log dedup. */
export const EXT_STATE_LOG_WINDOW_MS = 60_000;

const TOP_LEVEL_PER_TAB_KEYS = new Set([
  "messages",
  "draft",
  "waiting",
  "queueCount",
  "canvas",
  "model",
]);

export interface StateMutationDeps {
  send: (obj: Record<string, unknown>) => void;
  /** Rate-limited log-decision helper. The default factory makes a 60s
   *  window-bound limiter; tests can swap in a counting stub. */
  extStateLogLimiter?: RateLimiter;
}

export function setState(
  state: AethonAgentState,
  deps: StateMutationDeps,
  path: string,
  value: unknown,
  sourceTabId?: string,
): Promise<MutationResult> {
  if (!path || typeof path !== "string") {
    return Promise.resolve({ ok: false, error: "path required" });
  }
  const limiter =
    deps.extStateLogLimiter ?? makeExtStateLogLimiter(EXT_STATE_LOG_WINDOW_MS);
  const extStateLog = logger.scope("ext-state");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Non-serializable values will fail naturally in send() below.
  }
  if (serialized !== undefined) {
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (state.currentExtensionName) {
      state.extPathOwners.set(path, state.currentExtensionName);
    }
    const attributed =
      state.currentExtensionName ?? state.extPathOwners.get(path) ?? null;
    const who = attributed ? ` (${attributed})` : "";
    const ext = attributed ?? "?";
    if (bytes > state.statePayloadHardBytes) {
      const kb = Math.round(bytes / 1024);
      const decision = limiter.shouldLog(`reject|${ext}|${path}`);
      if (decision.log) {
        const tail =
          decision.suppressed > 0
            ? ` (+${decision.suppressed} suppressed in last ${EXT_STATE_LOG_WINDOW_MS / 1000}s)`
            : "";
        extStateLog.warn(
          `setState rejected: path=${path} size=${kb}KB exceeds ${state.statePayloadHardKb}KB limit${who}${tail} — store file paths, not content`,
        );
      }
      // User-facing notification: send once per (ext+kind+path), not on
      // every limiter window. The toast is sticky and the user can't
      // un-see it; periodic re-pops are pure noise. Cleared when the
      // same path receives a successful setState.
      const notifyKey = `${ext}|state-too-large|${path}`;
      if (!state.notifiedExtRuntimeErrors.has(notifyKey)) {
        state.notifiedExtRuntimeErrors.add(notifyKey);
        deps.send({
          type: "extension_runtime_error",
          name: attributed,
          kind: "state-too-large",
          path,
          sizeKB: kb,
          limitKB: state.statePayloadHardKb,
        });
      }
      return Promise.resolve({
        ok: false,
        error: `payload exceeds ${state.statePayloadHardKb} KB limit — store file paths, not content`,
      });
    }
    if (bytes > state.statePayloadWarnBytes) {
      const kb = Math.round(bytes / 1024);
      const decision = limiter.shouldLog(`large|${ext}|${path}`);
      if (decision.log) {
        const tail =
          decision.suppressed > 0
            ? ` (+${decision.suppressed} suppressed in last ${EXT_STATE_LOG_WINDOW_MS / 1000}s)`
            : "";
        extStateLog.warn(
          `setState large payload: path=${path} size=${kb}KB${who}${tail}`,
        );
      }
    }
  }
  // Successful write below the hard cap — clear any sticky
  // notification flag for this path so a future regression re-notifies.
  if (serialized !== undefined) {
    const ext =
      state.currentExtensionName ?? state.extPathOwners.get(path) ?? "?";
    state.notifiedExtRuntimeErrors.delete(`${ext}|state-too-large|${path}`);
  }
  // tabId attribution priority: explicit → ALS → currentAgentTabId.
  // setIntervals registered at module-load time have NO ALS context —
  // those fall through to currentAgentTabId / undefined.
  const attributedTab =
    sourceTabId ?? state.tabContext.getStore() ?? state.currentAgentTabId;
  const segs = path.split("/").filter(Boolean);
  const top = segs[0];
  const isMirroredPerTab =
    attributedTab !== undefined && TOP_LEVEL_PER_TAB_KEYS.has(top);
  if (isMirroredPerTab && attributedTab) {
    const before = state.perTabExtState.get(attributedTab) ?? {};
    state.perTabExtState.set(
      attributedTab,
      setAtPointer(before, path, value),
    );
  } else {
    state.extensionStateTree = setAtPointer(
      state.extensionStateTree,
      path,
      value,
    );
    state.extensionStateKeys.add(path);
  }
  const { id, promise } = trackMutation(state);
  deps.send({
    type: "state_patch",
    mutationId: id,
    path,
    value,
    ...(attributedTab ? { tabId: attributedTab } : {}),
  });
  return promise;
}

/** Read the frontend's currently-active tab id from its mirrored /tabs
 *  slice (each tab carries `active: true|false`). Used by the canvas
 *  resolver as a fallback when no ALS / current turn is set. Returns
 *  `undefined` if frontendState hasn't received /tabs yet (pre-ready). */
export function frontendActiveTabId(
  state: AethonAgentState,
): string | undefined {
  const tabsSlice = state.frontendState.get("/tabs");
  if (!Array.isArray(tabsSlice)) return undefined;
  for (const t of tabsSlice) {
    if (
      t &&
      typeof t === "object" &&
      (t as { active?: unknown }).active === true &&
      typeof (t as { id?: unknown }).id === "string"
    ) {
      return (t as { id: string }).id;
    }
  }
  return undefined;
}

/** Build a tab-aware canvas API. Tab attribution is locked at call time
 *  via the four-step priority chain in canvas.ts.
 *
 *  `boundTabId` ties this canvas to a specific tab when called from a
 *  handler (so concurrent dispatches on different tabs see their own
 *  state). For the global aethonApi.canvas, leave boundTabId undefined
 *  and the resolver falls through to ALS / current turn / frontend
 *  active / "default". */
export function makeCanvasApi(
  state: AethonAgentState,
  deps: StateMutationDeps,
  boundTabId: string | undefined,
): CanvasApi {
  return buildCanvasApi(boundTabId, {
    setState: (path, value, sourceTabId) =>
      setState(state, deps, path, value, sourceTabId),
    resolveTab: (explicit) =>
      explicit ??
      state.tabContext.getStore() ??
      state.currentAgentTabId ??
      frontendActiveTabId(state) ??
      "default",
    readCanvasComponents: (id) => {
      const tabState = state.perTabExtState.get(id);
      if (
        tabState &&
        (tabState as { canvas?: unknown }).canvas !== undefined
      ) {
        return readCanvasComponentsFromTabState(tabState);
      }
      const activeForSeed = frontendActiveTabId(state) ?? "default";
      if (id === activeForSeed) {
        return readCanvasComponentsFromTabState(state.extensionStateTree);
      }
      return [];
    },
  });
}
