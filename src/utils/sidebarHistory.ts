/**
 * Sidebar chat-history item ids carry one of two prefixes:
 *   - `tab:<id>`     — the session is currently open as an agent tab
 *   - `session:<id>` — the session is closed but discoverable on disk
 *
 * Both forms map to the same underlying tabId / sessionId (they're the
 * same string in the bridge). The right-click "Delete session" action
 * accepts either; this helper normalizes the input so the Tauri
 * command's path validator never sees a stray prefix.
 */
export function extractSessionId(itemId: string): string {
  if (itemId.startsWith("session:")) return itemId.slice("session:".length);
  if (itemId.startsWith("tab:")) return itemId.slice("tab:".length);
  return itemId;
}

/**
 * Whether a sidebar chat-history item id represents something that can
 * be deleted via the context menu — currently both prefixes qualify.
 * Anything without a known prefix (future kinds, malformed ids) is
 * left alone so we don't show a delete action that would no-op.
 */
export function canDeleteHistoryItem(itemId: string): boolean {
  return itemId.startsWith("session:") || itemId.startsWith("tab:");
}
