import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../types/tab";
import { isAgentTabInFlight } from "../utils/agentBusy";

interface TraySessionItemWire {
  id: string;
  label: string;
  detail?: string;
  active: boolean;
  running: boolean;
  needs_attention: boolean;
  queued_count: number;
}

interface CollectedTab {
  tab: Tab;
  visible: boolean;
}

function pathBasename(path: string | undefined): string | undefined {
  const trimmed = (path ?? "").replace(/[/\\]+$/, "");
  if (!trimmed) return undefined;
  return trimmed.split(/[/\\]/).pop() || undefined;
}

function firstUserLabel(tab: Tab): string | undefined {
  const first = tab.messages.find(
    (message) =>
      message.role === "user" &&
      typeof message.text === "string" &&
      message.text.trim().length > 0,
  );
  const text = first?.text?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 56 ? `${text.slice(0, 53)}...` : text;
}

function displayLabel(tab: Tab): string {
  if (/^Tab \d+$/.test(tab.label)) {
    return firstUserLabel(tab) ?? tab.label;
  }
  return tab.label;
}

function collectAgentTabs(state: Record<string, unknown>): CollectedTab[] {
  const result: CollectedTab[] = [];
  const seen = new Set<string>();
  const add = (tabs: Tab[] | undefined, visible: boolean) => {
    for (const tab of tabs ?? []) {
      if (tab.kind !== "agent") continue;
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      result.push({ tab, visible });
    }
  };
  add((state.tabs as Tab[] | undefined) ?? [], true);
  const buckets = state.persistedTabBuckets as
    | Record<string, { tabs?: Tab[] }>
    | undefined;
  if (buckets) {
    for (const bucket of Object.values(buckets)) {
      add(bucket?.tabs, false);
    }
  }
  return result;
}

export function buildTraySessionItems(
  state: Record<string, unknown>,
): TraySessionItemWire[] {
  const activeTabId = state.activeTabId as string | undefined;
  const running = new Set(
    Object.keys(
      (state.agentRunningTabs as Record<string, unknown> | undefined) ?? {},
    ),
  );
  const attention = new Set(
    Object.keys(
      (state.agentAttentionTabs as Record<string, unknown> | undefined) ?? {},
    ),
  );

  return collectAgentTabs(state)
    .map(({ tab, visible }): TraySessionItemWire => {
      const isRunning =
        running.has(tab.id) || (visible && isAgentTabInFlight(tab));
      const queuedCount = Math.max(
        tab.queuedMessages?.length ?? 0,
        tab.queueCount ?? 0,
      );
      return {
        id: tab.id,
        label: displayLabel(tab),
        ...(pathBasename(tab.cwd) ? { detail: pathBasename(tab.cwd) } : {}),
        active: tab.id === activeTabId,
        running: isRunning,
        needs_attention: !isRunning && attention.has(tab.id),
        queued_count: queuedCount,
      };
    })
    .sort((a, b) => {
      const rank = (item: TraySessionItemWire) =>
        item.active ? 0 : item.running ? 1 : item.needs_attention ? 2 : 3;
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.label.localeCompare(b.label);
    });
}

export function useTraySessionsSync(state: Record<string, unknown>): void {
  const lastSerializedRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const items = buildTraySessionItems(state);
      const serialized = JSON.stringify(items);
      if (serialized === lastSerializedRef.current) return;
      lastSerializedRef.current = serialized;
      invoke("set_tray_sessions", { items }).catch(() => {
        // Tauri may be unavailable in unit tests or during early reload.
        // Clear the diff so the next state change retries.
        lastSerializedRef.current = "";
      });
    }, 50);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state]);
}
