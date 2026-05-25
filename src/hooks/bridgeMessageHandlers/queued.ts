import type { BridgeMessageHandler } from "./types";

/** Bridge `queued` event — emitted when pi accepts a chat IPC into its
 *  followUp queue while a prompt is in flight. With the Claudette-style
 *  client-held queue, the frontend no longer invokes `send_message`
 *  during a busy turn, so pi's followUp stays empty and this event
 *  effectively never fires. We keep the handler registered (and as a
 *  no-op) so a stray emission can't corrupt `queueCount`, which now
 *  derives strictly from `tab.queuedMessages.length`. Mutating
 *  queueCount here would desync the badge from the popover.
 *  See: src/types/tab.ts contract on the `queueCount` field. */
export const handleQueued: BridgeMessageHandler = (_data, _ctx) => {
  // intentionally empty
};
