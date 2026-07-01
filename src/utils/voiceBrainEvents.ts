/** Window-level signals for voice-brain bridge messages, decoupling the
 *  bridge handler (which sees `voice_brain_*` messages) from the cascade
 *  conversation hook — the same pattern as agentTurnEvents.ts. */

export const VOICE_BRAIN_DELTA_EVENT = "aethon://voice-brain-delta";
export const VOICE_BRAIN_END_EVENT = "aethon://voice-brain-end";
export const VOICE_BRAIN_ERROR_EVENT = "aethon://voice-brain-error";

export interface VoiceBrainDeltaDetail {
  text: string;
}

export interface VoiceBrainEndDetail {
  text: string;
  dispatched?: { tabId: string; label: string };
}

export interface VoiceBrainErrorDetail {
  message: string;
}

function emit<T>(name: string, detail: T): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

export const emitVoiceBrainDelta = (detail: VoiceBrainDeltaDetail): void =>
  emit(VOICE_BRAIN_DELTA_EVENT, detail);
export const emitVoiceBrainEnd = (detail: VoiceBrainEndDetail): void =>
  emit(VOICE_BRAIN_END_EVENT, detail);
export const emitVoiceBrainError = (detail: VoiceBrainErrorDetail): void =>
  emit(VOICE_BRAIN_ERROR_EVENT, detail);

function on<T>(name: string, listener: (detail: T) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    listener((event as CustomEvent<T>).detail);
  };
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

export const onVoiceBrainDelta = (
  listener: (detail: VoiceBrainDeltaDetail) => void,
): (() => void) => on(VOICE_BRAIN_DELTA_EVENT, listener);
export const onVoiceBrainEnd = (
  listener: (detail: VoiceBrainEndDetail) => void,
): (() => void) => on(VOICE_BRAIN_END_EVENT, listener);
export const onVoiceBrainError = (
  listener: (detail: VoiceBrainErrorDetail) => void,
): (() => void) => on(VOICE_BRAIN_ERROR_EVENT, listener);
