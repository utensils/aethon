import type { BridgeMessageHandler } from "./types";
import {
  emitVoiceBrainDelta,
  emitVoiceBrainEnd,
  emitVoiceBrainError,
} from "../../utils/voiceBrainEvents";

/** `voice_brain_delta` / `voice_brain_end` / `voice_brain_error` from the
 *  global bridge's voice-brain session. Re-broadcast as window events for the
 *  cascade conversation hook — no app state is touched, so the handler stays
 *  a pure fan-out (the hook owns the conversation lifecycle). */
export const handleVoiceBrainDelta: BridgeMessageHandler = (data) => {
  const text = data.text;
  if (typeof text === "string" && text.length > 0) {
    emitVoiceBrainDelta({ text });
  }
};

export const handleVoiceBrainEnd: BridgeMessageHandler = (data) => {
  const text = typeof data.text === "string" ? data.text : "";
  const rawDispatched = data.dispatched as
    | { tabId?: unknown; label?: unknown }
    | undefined;
  const dispatched =
    rawDispatched && typeof rawDispatched.tabId === "string"
      ? {
          tabId: rawDispatched.tabId,
          label:
            typeof rawDispatched.label === "string" ? rawDispatched.label : "",
        }
      : undefined;
  emitVoiceBrainEnd({ text, ...(dispatched ? { dispatched } : {}) });
};

export const handleVoiceBrainError: BridgeMessageHandler = (data) => {
  const message =
    typeof data.message === "string" && data.message
      ? data.message
      : "The voice assistant failed to reply";
  emitVoiceBrainError({ message });
};
