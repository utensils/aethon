export interface TranscriptPerfSnapshot {
  tabId?: string;
  activeTabId?: string;
  messageCount: number;
  groupCount: number;
  rowCount: number;
  mountedRowCount: number;
  mountedToolCardCount: number;
  following: boolean;
  canScroll: boolean;
  scroll: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    bottomGap: number;
  } | null;
  updatedAt: number;
}

interface TranscriptPerfDebug {
  list: () => TranscriptPerfSnapshot[];
  get: (tabId?: string) => TranscriptPerfSnapshot | undefined;
  clear: () => void;
}

const snapshots = new Map<string, TranscriptPerfSnapshot>();

function snapshotKey(tabId: string | undefined): string {
  return tabId ?? "standalone";
}

function installDebugApi(): void {
  if (typeof window === "undefined" || !import.meta.env.DEV) return;
  const win = window as unknown as {
    __AETHON_TRANSCRIPT_PERF__?: TranscriptPerfDebug;
  };
  if (win.__AETHON_TRANSCRIPT_PERF__) return;
  win.__AETHON_TRANSCRIPT_PERF__ = {
    list: () => Array.from(snapshots.values()),
    get: (tabId?: string) => snapshots.get(snapshotKey(tabId)),
    clear: () => snapshots.clear(),
  };
}

export function recordTranscriptPerfSnapshot(
  snapshot: Omit<TranscriptPerfSnapshot, "updatedAt">,
): void {
  if (!import.meta.env.DEV) return;
  installDebugApi();
  snapshots.set(snapshotKey(snapshot.tabId), {
    ...snapshot,
    updatedAt:
      typeof performance === "undefined" ? Date.now() : performance.now(),
  });
}
