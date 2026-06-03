import type { BridgeMessageHandler } from "./types";

interface OrderedEntry {
  entryId: string;
  role: "user" | "agent";
}

function coerceEntries(value: unknown): OrderedEntry[] {
  if (!Array.isArray(value)) return [];
  const out: OrderedEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { entryId?: unknown; role?: unknown };
    if (typeof record.entryId !== "string" || record.entryId.length === 0) {
      continue;
    }
    if (record.role === "user" || record.role === "agent") {
      out.push({ entryId: record.entryId, role: record.role });
    }
  }
  return out;
}

/**
 * Back-fill pi session entry ids onto a tab's *live* transcript so the
 * rollback / fork affordances have a valid handle before a reload (restored
 * transcripts already carry entry ids via the session-history path).
 *
 * The bridge emits the branch's user/assistant message entries in order. We
 * walk the transcript and the entry list together, assigning each entry to the
 * next text row of the matching role. Tool-card and system rows are skipped;
 * a multi-segment assistant turn (text → tool → text) renders as several agent
 * rows but is one assistant entry, so only the first agent text row of the turn
 * gets the id (rolling back there branches at the right entry). Rows whose role
 * doesn't match the current expected entry are skipped, keeping alignment
 * robust across the interleaving.
 */
export const handleEntryIds: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const ordered = coerceEntries(data.entries);
  if (ordered.length === 0) return;

  ctx.updateTab(tabId, (tab) => {
    let entryIdx = 0;
    let changed = false;
    const messages = tab.messages.map((message) => {
      if (entryIdx >= ordered.length) return message;
      const isTextRow =
        (message.role === "user" || message.role === "agent") &&
        typeof message.text === "string" &&
        message.text.length > 0;
      if (!isTextRow) return message;
      const next = ordered[entryIdx];
      // Role mismatch: this row belongs to a later/earlier turn segment than
      // the current entry expects (e.g. a second agent text segment). Skip it
      // and keep the entry for the next matching-role row.
      if (next.role !== message.role) return message;
      entryIdx += 1;
      if (message.entryId === next.entryId) return message;
      changed = true;
      return { ...message, entryId: next.entryId };
    });
    return changed ? { ...tab, messages } : tab;
  });
};
