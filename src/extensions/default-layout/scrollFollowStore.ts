import type { ListRange } from "react-virtuoso";
import {
  anchorMessageIdForRow,
  findRowIndexForMessageId,
  type TranscriptRow,
} from "../../utils/transcriptRows";

export interface TabScrollAnchorStore {
  clear(): void;
  delete(tabId: string): void;
  get(tabId: string): string | undefined;
  has(tabId: string): boolean;
  set(tabId: string, anchorId: string): void;
}

export function createTabScrollAnchorStore(): TabScrollAnchorStore {
  const anchors = new Map<string, string>();
  return {
    clear: () => anchors.clear(),
    delete: (tabId) => anchors.delete(tabId),
    get: (tabId) => anchors.get(tabId),
    has: (tabId) => anchors.has(tabId),
    set: (tabId, anchorId) => anchors.set(tabId, anchorId),
  };
}

export const defaultTabScrollAnchorStore = createTabScrollAnchorStore();

export function restoreAnchorForTab(
  store: TabScrollAnchorStore,
  tabId: string | undefined,
): string | undefined {
  return tabId === undefined ? undefined : store.get(tabId);
}

export function initialIndexForRestoreAnchor({
  rows,
  restoreAnchorId,
}: {
  rows: TranscriptRow[];
  restoreAnchorId: string | undefined;
}): {
  initialTopMostItemIndex: { index: number; align: "start" | "end" };
  restoreIndex: number;
} {
  const restoreIndex = restoreAnchorId
    ? findRowIndexForMessageId(rows, restoreAnchorId)
    : -1;
  return {
    restoreIndex,
    initialTopMostItemIndex:
      restoreIndex >= 0
        ? { index: restoreIndex, align: "start" }
        : { index: Math.max(0, rows.length - 1), align: "end" },
  };
}

export function updateAnchorFromRange({
  following,
  range,
  rows,
  store,
  tabId,
}: {
  following: boolean;
  range: ListRange;
  rows: TranscriptRow[];
  store: TabScrollAnchorStore;
  tabId: string | undefined;
}): void {
  if (tabId === undefined || following) return;
  const anchorId = anchorMessageIdForRow(rows[range.startIndex]);
  if (anchorId) store.set(tabId, anchorId);
}

export function updateAnchorFromUserScroll({
  atBottom,
  range,
  rows,
  store,
  tabId,
}: {
  atBottom: boolean;
  range: ListRange | null;
  rows: TranscriptRow[];
  store: TabScrollAnchorStore;
  tabId: string | undefined;
}): void {
  if (tabId === undefined) return;
  if (atBottom) {
    store.delete(tabId);
    return;
  }
  const anchorId = anchorMessageIdForRow(rows[range?.startIndex ?? 0]);
  if (anchorId) store.set(tabId, anchorId);
}

export function dropStaleRestoreAnchor({
  restoreAnchorId,
  restoreIndex,
  store,
  tabId,
}: {
  restoreAnchorId: string | undefined;
  restoreIndex: number;
  store: TabScrollAnchorStore;
  tabId: string | undefined;
}): boolean {
  if (!restoreAnchorId || restoreIndex >= 0 || tabId === undefined) return false;
  store.delete(tabId);
  return true;
}
