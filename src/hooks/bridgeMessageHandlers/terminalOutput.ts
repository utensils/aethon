import { TERMINAL_REPLAY_MAX } from "../useTabs";
import type { BridgeMessageHandler } from "./types";

export const handleTerminalOutput: BridgeMessageHandler = (data, ctx) => {
  const content = (data.content as string) ?? "";
  if (!content) return;
  const tabId = (data.tabId as string | undefined) ?? "default";
  // Append to the originating tab's buffer (cap from the right so older
  // content rotates out first). Three sinks now consume each chunk:
  //   1. Per-tab Tab.terminalBuffer — the React record carrying the
  //      rolling scrollback. Used by tab-switch replay.
  //   2. Layout state at /terminal/buffer/<tabId> — bound by $ref from
  //      any A2UI component that wants the live stream (logging skills,
  //      alternative renderers).
  //   3. window CustomEvents — `aethon:terminal` (active tab only,
  //      drives xterm) and `aethon:terminal-tap` (every chunk regardless
  //      of active tab, for multi-subscriber listeners that need the
  //      full stream).
  ctx.updateTab(tabId, (tab) => {
    const next = (tab.terminalBuffer ?? "") + content;
    const trimmed =
      next.length > TERMINAL_REPLAY_MAX
        ? next.slice(next.length - TERMINAL_REPLAY_MAX)
        : next;
    return { ...tab, terminalBuffer: trimmed };
  });
  // Mirror the rolling buffer into shared layout state under
  // /terminal/buffer/<tabId>. A2UI components can $ref it; the bridge
  // sees it via getFrontendState. Path-based so an extension bound to
  // ONE tab doesn't pick up every tab's stream.
  ctx.setState((prev) => {
    const term = (prev.terminal as Record<string, unknown> | undefined) ?? {};
    const buffers = (term.buffer as Record<string, string> | undefined) ?? {};
    const next = (buffers[tabId] ?? "") + content;
    const trimmed =
      next.length > TERMINAL_REPLAY_MAX
        ? next.slice(next.length - TERMINAL_REPLAY_MAX)
        : next;
    return {
      ...prev,
      terminal: {
        ...term,
        buffer: { ...buffers, [tabId]: trimmed },
      },
    };
  });
  if ((ctx.stateRef.current.activeTabId as string | undefined) === tabId) {
    window.dispatchEvent(
      new CustomEvent("aethon:terminal", { detail: content }),
    );
  }
  // Tap event always fires (every tab, including background ones) so
  // multi-subscriber listeners can attach without monkey-patching the
  // existing single-subscriber pattern. detail carries tabId so the
  // listener can filter.
  window.dispatchEvent(
    new CustomEvent("aethon:terminal-tap", {
      detail: { tabId, content },
    }),
  );
};
