import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { onAgentTurnComplete } from "../utils/agentTurnEvents";
import { speakVoice } from "../services/voice";
import { capSpokenText } from "../utils/voice";

interface VoiceSettingsSlice {
  speakAgentReplies?: boolean;
  speakMaxChars?: number;
}

const DEFAULT_MAX_CHARS = 600;

/** Speak the agent's reply aloud when a turn completes, if the user enabled
 *  "speak agent replies" and the turn finished on the *active* tab. Reads
 *  config + active tab from the live state ref so it never goes stale and the
 *  listener is registered only once. Best-effort: synthesis/playback errors
 *  (e.g. model not downloaded) are swallowed — the Settings panel surfaces
 *  provider state. */
export function useSpeakReplies(
  stateRef: MutableRefObject<Record<string, unknown>>,
): void {
  useEffect(() => {
    return onAgentTurnComplete(({ tabId, text }) => {
      const state = stateRef.current;
      const voice = (state.voice as VoiceSettingsSlice | undefined) ?? {};
      if (!voice.speakAgentReplies) return;
      if (tabId !== (state.activeTabId as string | undefined)) return;

      const maxChars =
        typeof voice.speakMaxChars === "number" && voice.speakMaxChars > 0
          ? voice.speakMaxChars
          : DEFAULT_MAX_CHARS;
      const spoken = capSpokenText(text, maxChars);
      if (!spoken) return;

      void speakVoice(spoken).catch(() => {
        // Swallow — a missing model / disabled provider shouldn't raise here.
      });
    });
  }, [stateRef]);
}
