import type { BridgeMessageHandler } from "./types";

/** Bridge `queue_reset` event — emitted when pi drops its followUp
 *  queue (typically on Stop). On the Claudette-style client-held
 *  queue path, pi's followUp queue is unused, so this event
 *  effectively never fires. `tab.queueCount` derives from
 *  `tab.queuedMessages.length` and is cleared by `stopPrompt`
 *  directly when the user clicks Stop; mutating queueCount here
 *  would desync the badge from the popover.
 *  See: src/types/tab.ts contract on the `queueCount` field. */
export const handleQueueReset: BridgeMessageHandler = (_data, _ctx) => {
  // intentionally empty
};
