import type { AethonAgentState, DiscoveredTab } from "./state";
import {
  normalizeSessionLabel,
  readSessionMetadata,
  writeSessionLabel,
} from "./session-history";
import { tabSessionDir } from "./tab-lifecycle/utils";

interface SessionLabelDeps {
  send: (obj: Record<string, unknown>) => void;
}

export interface SetSessionLabelOptions {
  requireNonEmpty?: boolean;
  syncPiSessionName?: (label: string) => void;
}

export interface SetSessionLabelResult {
  label: string;
  session?: DiscoveredTab;
}

function upsertDiscoveredTab(
  state: AethonAgentState,
  tabId: string,
  refreshed: Omit<DiscoveredTab, "tabId"> | null,
): DiscoveredTab | undefined {
  if (!refreshed) return undefined;
  const entry = { tabId, ...refreshed };
  const idx = state.discoveredTabs.findIndex((t) => t.tabId === tabId);
  if (idx >= 0) state.discoveredTabs[idx] = entry;
  else state.discoveredTabs.push(entry);
  state.discoveredTabs.sort((a, b) => b.lastModified - a.lastModified);
  return entry;
}

export async function setSessionLabelForTab(
  state: AethonAgentState,
  deps: SessionLabelDeps,
  tabId: string,
  rawLabel: string,
  options: SetSessionLabelOptions = {},
): Promise<SetSessionLabelResult> {
  const label = normalizeSessionLabel(rawLabel);
  if (options.requireNonEmpty === true && !label) {
    throw new Error("setSessionTabTitle: title required");
  }
  await writeSessionLabel(tabSessionDir(state, tabId), label);
  if (label && options.syncPiSessionName) {
    options.syncPiSessionName(label);
  }
  const session = upsertDiscoveredTab(
    state,
    tabId,
    await readSessionMetadata(tabSessionDir(state, tabId)),
  );
  deps.send({
    type: "session_label_changed",
    tabId,
    label,
    ...(session ? { session } : {}),
  });
  return { label, ...(session ? { session } : {}) };
}
