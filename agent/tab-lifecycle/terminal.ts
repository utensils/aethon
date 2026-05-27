/**
 * Terminal output emission for the agent-bash sub-tab. Caps a single
 * emit at TERMINAL_MAX_BYTES (trailing window) and chunks the body so
 * the renderer can paint progressively without blocking on a huge
 * single message.
 */

import type { TabLifecycleDeps } from "./utils";

const TERMINAL_MAX_BYTES = 64 * 1024;
const TERMINAL_CHUNK_BYTES = 8 * 1024;

/** Format and forward bash output to the terminal panel in chunks. Caps
 *  a single emit at TERMINAL_MAX_BYTES (trailing window). */
export function emitBashResult(
  deps: TabLifecycleDeps,
  text: string,
  tabId: string,
): void {
  if (!text) return;
  let body = text;
  let truncated = false;
  if (body.length > TERMINAL_MAX_BYTES) {
    body = body.slice(body.length - TERMINAL_MAX_BYTES);
    truncated = true;
  }
  if (truncated) {
    deps.send({
      type: "terminal_output",
      tabId,
      content: `\r\n[…output truncated to last ${TERMINAL_MAX_BYTES} bytes]\r\n`,
    });
  }
  const normalized = body.replace(/\r?\n/g, "\r\n");
  for (let i = 0; i < normalized.length; i += TERMINAL_CHUNK_BYTES) {
    deps.send({
      type: "terminal_output",
      tabId,
      content: normalized.slice(i, i + TERMINAL_CHUNK_BYTES),
    });
  }
}
