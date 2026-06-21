import { useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  switchAccountForTab,
  type AccountSwitchTarget,
} from "../auth-profiles/commands";
import { OVERVIEW_TAB_ID, type Tab } from "../types/tab";
import { isAgentTabBusy } from "../utils/agentBusy";
import {
  cancelControlWait,
  registerControlWait,
} from "./controlWaitRegistry";

/** Default ceiling for `chat.send --wait` / `chat.wait` when the caller does
 *  not pass `timeoutMs`. Generous because real agent turns routinely run for
 *  minutes; the caller can always Ctrl-C the CLI. */
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

export interface ControlRequestPayload {
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface UseControlRequestsContext {
  stateRef: MutableRefObject<Record<string, unknown>>;
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  newTab: (
    tabId?: string,
    label?: string,
    options?: { cwd?: string; model?: string; restoredSession?: boolean },
  ) => void;
  closeTabNow: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updater: (tab: Tab) => Tab) => void;
  sendChat: (
    text: string,
    options?: { tabId?: string; bridgeText?: string; controlRequestId?: string },
  ) => Promise<void>;
  stopPrompt: (tabId?: string) => Promise<void>;
}

export function useControlRequests(ctx: UseControlRequestsContext): void {
  // Keep the live context in a ref so the listener can read the latest actions
  // without re-subscribing on every App render. Subscribing with `[ctx]` (a
  // fresh object literal each render) would tear down and re-register the
  // `control-request` listener constantly and could briefly run duplicate
  // handlers (Tauri's unlisten is async).
  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  });
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<ControlRequestPayload>(
      "control-request",
      async (event) => {
        const request = event.payload;
        if (!request?.requestId) return;
        try {
          const data = await handleControlRequest(ctxRef.current, request);
          if (!disposed) {
            await completeControlRequest(request.requestId, true, data);
          }
        } catch (err) {
          if (!disposed) {
            await completeControlRequest(
              request.requestId,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      },
    );
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, []);
}

async function completeControlRequest(
  requestId: string,
  success: boolean,
  data?: unknown,
  error?: string,
): Promise<void> {
  try {
    await invoke("control_request_complete", {
      requestId,
      success,
      ...(data !== undefined ? { data } : {}),
      ...(error ? { error } : {}),
    });
  } catch {
    // The backend already dropped this pending request (e.g. its own timeout
    // fired and purged the entry) or the command isn't registered yet on an
    // older shell. Either way there's nothing left to complete — swallow it so
    // a late completion can't turn into a second, also-failing attempt.
  }
}

async function handleControlRequest(
  ctx: UseControlRequestsContext,
  request: ControlRequestPayload,
): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "tabs.open":
      return openTab(ctx, params);
    case "tabs.close":
      return closeTab(ctx, params);
    case "tabs.focus":
      return focusTab(ctx, params);
    case "accounts.use":
      return applyAccount(ctx, params);
    case "chat.send":
      return sendChat(ctx, request.requestId, params);
    case "chat.wait":
      return waitForIdle(ctx, params);
    case "agent.stop":
      return stopAgent(ctx, params);
    default:
      throw new Error(`unsupported control request: ${request.method}`);
  }
}

async function openTab(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tabId = stringParam(params, "tabId") ?? crypto.randomUUID();
  const label = stringParam(params, "label") ?? "CLI";
  const cwd = stringParam(params, "cwd");
  const model = stringParam(params, "model");
  const account = stringParam(params, "account");
  ctx.newTab(tabId, label, { cwd, model });
  await ctx.pendingTabOpens.current.get(tabId);
  if (account) {
    await switchAccountForTab(tabId, account, { cwd, model });
    ctx.updateTab(tabId, (tab) => ({ ...tab, authProfileId: account }));
  }
  return { id: tabId, kind: "agent", label, cwd, model, authProfileId: account };
}

function closeTab(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): unknown {
  const tabId = requiredString(params, "tabId", "tabs.close requires tabId");
  ctx.closeTabNow(tabId);
  return { closed: tabId };
}

function focusTab(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): unknown {
  const tabId = requiredString(params, "tabId", "tabs.focus requires tabId");
  ctx.setActiveTab(tabId);
  return { activeTabId: tabId };
}

async function applyAccount(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): Promise<unknown> {
  const profileId = requiredString(params, "profileId", "accounts.use requires profileId");
  const target = resolveControlAccountTarget(ctx, stringParam(params, "tabId") ?? "active");
  if (target.busy) {
    throw new Error(`tab ${target.tabId} is busy; stop or wait before switching accounts`);
  }
  await switchAccountForTab(target.tabId, profileId, {
    cwd: target.cwd,
    model: target.model,
  });
  if (target.tabId !== "default") {
    ctx.updateTab(target.tabId, (tab) => ({ ...tab, authProfileId: profileId }));
  }
  return { profileId, target };
}

async function sendChat(
  ctx: UseControlRequestsContext,
  requestId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const message = requiredString(params, "message", "chat.send requires message");
  const tabId = resolveControlTabId(ctx, stringParam(params, "tabId") ?? "active");
  const account = stringParam(params, "account");
  if (account) {
    const target = resolveControlAccountTarget(ctx, tabId);
    if (target.busy) {
      throw new Error(`tab ${target.tabId} is busy; stop or wait before switching accounts`);
    }
    await switchAccountForTab(target.tabId, account, {
      cwd: target.cwd,
      model: target.model,
    });
    if (target.tabId !== "default") {
      ctx.updateTab(target.tabId, (tab) => ({ ...tab, authProfileId: account }));
    }
  }
  // Wire --plan / --thinking-level onto the target tab so the dispatched turn
  // picks them up (useChat reads planMode/thinkingLevel from the tab, not from
  // sendChat options). Previously these CLI flags were silently ignored.
  applyTurnOptions(ctx, tabId, params);

  const wait = params.wait === true;
  const timeoutMs = finiteNumber(params.timeoutMs) ?? DEFAULT_WAIT_MS;
  // Register the wait BEFORE dispatching so the turn's terminal event can't
  // land before we're listening for it.
  const waitPromise = wait
    ? registerControlWait(requestId, tabId, timeoutMs)
    : undefined;
  try {
    await ctx.sendChat(message, { tabId, controlRequestId: requestId });
  } catch (err) {
    if (wait) cancelControlWait(requestId);
    throw err;
  }
  const result: Record<string, unknown> = { sent: true, tabId };
  if (account) result.account = account;
  if (waitPromise) result.wait = await waitPromise;
  return result;
}

function applyTurnOptions(
  ctx: UseControlRequestsContext,
  tabId: string,
  params: Record<string, unknown>,
): void {
  const planMode =
    typeof params.planMode === "boolean" ? params.planMode : undefined;
  const thinkingLevel = stringParam(params, "thinkingLevel");
  if (planMode === undefined && !thinkingLevel) return;
  // Only real agent tabs carry these per-tab toggles; the default-tab fallback
  // has no Tab object to patch.
  if (!tabs(ctx.stateRef.current).some((t) => t.id === tabId)) return;
  ctx.updateTab(tabId, (tab) => ({
    ...tab,
    ...(planMode !== undefined ? { planMode } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function waitForIdle(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tabId = resolveControlTabId(ctx, stringParam(params, "tabId") ?? "active");
  const timeoutMs = finiteNumber(params.timeoutMs) ?? DEFAULT_WAIT_MS;
  const start = Date.now();
  let sawBusy = false;
  while (Date.now() - start < timeoutMs) {
    const busy = isControlTabBusy(ctx.stateRef.current, tabId);
    sawBusy = sawBusy || busy;
    if (!busy && sawBusy) {
      return { waiting: false, tabId, elapsedMs: Date.now() - start };
    }
    if (!busy && !sawBusy && Date.now() - start > 300) {
      return { waiting: false, tabId, elapsedMs: Date.now() - start };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return { waiting: true, tabId, timeoutMs };
}

async function stopAgent(
  ctx: UseControlRequestsContext,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tabId = resolveControlTabId(ctx, stringParam(params, "tabId") ?? "active");
  await ctx.stopPrompt(tabId);
  return { stopped: true, tabId };
}

function resolveControlAccountTarget(
  ctx: UseControlRequestsContext,
  requestedTabId: string,
): AccountSwitchTarget {
  const tabId = resolveControlTabId(ctx, requestedTabId);
  const tab = tabs(ctx.stateRef.current).find(
    (candidate) =>
      candidate.id === tabId &&
      candidate.id !== OVERVIEW_TAB_ID &&
      (candidate.kind ?? "agent") === "agent",
  );
  if (!tab) return { tabId: "default", busy: false };
  return {
    tabId: tab.id,
    cwd: tab.cwd,
    model: tab.model,
    busy: isAgentTabBusy(tab, { includeQueue: true }),
  };
}

function resolveControlTabId(
  ctx: UseControlRequestsContext,
  requestedTabId: string,
): string {
  if (requestedTabId !== "active") return requestedTabId;
  const active = ctx.stateRef.current.activeTabId;
  return typeof active === "string" && active.length > 0 ? active : "default";
}

function isControlTabBusy(state: Record<string, unknown>, tabId: string): boolean {
  const tab = tabs(state).find((candidate) => candidate.id === tabId);
  if (tab) return isAgentTabBusy(tab, { includeQueue: false });
  if (tabId === state.activeTabId) return state.waiting === true;
  return false;
}

function tabs(state: Record<string, unknown>): Tab[] {
  return Array.isArray(state.tabs) ? (state.tabs as Tab[]) : [];
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = stringParam(params, key);
  if (!value) throw new Error(message);
  return value;
}
