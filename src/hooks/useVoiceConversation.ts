import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelVoiceRecording,
  speakVoice,
  startVoiceRecording,
  stopAndTranscribeVoice,
  stopVoicePlayback,
} from "../services/voice";
import { onAgentTurnComplete } from "../utils/agentTurnEvents";
import { setConversationActive } from "../utils/conversationMode";
import { LFM2_VOICE_PROVIDER_ID, capSpokenText } from "../utils/voice";

/** A full turn of the LFM2-Audio conversation loop:
 *  idle → listening → transcribing → thinking → speaking → (continue|idle). */
export type ConversationPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface UseVoiceConversationOptions {
  /** Send the transcript to the agent (reuses the composer submit path). */
  submitText: (text: string) => void;
  /** The tab the conversation is bound to, captured at submit time. */
  getActiveTabId: () => string | undefined;
  /** Auto-reopen the mic after the agent finishes speaking. */
  continuous: boolean;
  /** Cap on spoken reply length (shared with speak-agent-replies). */
  maxSpokenChars: number;
  /** Routed to Settings when the LFM2 model/binary isn't ready. */
  onNeedsSetup?: (providerId: string) => void;
}

export interface VoiceConversationController {
  active: boolean;
  phase: ConversationPhase;
  error: string | null;
  enter: () => void;
  exit: () => void;
  /** Context-aware tap: start speaking / finish speaking / interrupt. */
  primaryAction: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useVoiceConversation(
  options: UseVoiceConversationOptions,
): VoiceConversationController {
  const [active, setActive] = useState(false);
  const [phase, setPhaseState] = useState<ConversationPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Mirror the latest values for use inside async callbacks / event listeners,
  // which would otherwise close over stale state.
  const phaseRef = useRef<ConversationPhase>("idle");
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const tabIdRef = useRef<string | undefined>(undefined);
  const optionsRef = useRef(options);
  // Keep the latest callbacks/config available to async transitions without a
  // render-phase ref write (mirrors the voiceInputBlockedRef pattern).
  useEffect(() => {
    optionsRef.current = options;
  });

  const setPhase = useCallback((next: ConversationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const startListening = useCallback(async () => {
    // Guard the start window: phase is still "idle" until the recorder opens,
    // so without this a second tap would fire another (rejected) start.
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      await startVoiceRecording(LFM2_VOICE_PROVIDER_ID);
      if (!activeRef.current) {
        // Conversation was exited while the start call was in flight.
        await cancelVoiceRecording(LFM2_VOICE_PROVIDER_ID).catch(() => {});
        return;
      }
      setPhase("listening");
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("idle");
      optionsRef.current.onNeedsSetup?.(LFM2_VOICE_PROVIDER_ID);
    } finally {
      startingRef.current = false;
    }
  }, [setPhase]);

  const goIdleOrContinue = useCallback(() => {
    if (activeRef.current && optionsRef.current.continuous) {
      void startListening();
    } else {
      setPhase("idle");
    }
  }, [setPhase, startListening]);

  const finishListening = useCallback(async () => {
    if (phaseRef.current !== "listening") return;
    setPhase("transcribing");
    try {
      const transcript = await stopAndTranscribeVoice(LFM2_VOICE_PROVIDER_ID);
      if (!activeRef.current) return;
      const text = transcript.trim();
      if (!text) {
        goIdleOrContinue();
        return;
      }
      // Bind the reply we await to the tab we sent on.
      tabIdRef.current = optionsRef.current.getActiveTabId();
      optionsRef.current.submitText(text);
      setPhase("thinking");
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("idle");
    }
  }, [goIdleOrContinue, setPhase]);

  const interrupt = useCallback(() => {
    void stopVoicePlayback().catch(() => {});
    void cancelVoiceRecording(LFM2_VOICE_PROVIDER_ID).catch(() => {});
    setPhase("idle");
  }, [setPhase]);

  const enter = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    setConversationActive(true);
    void startListening();
  }, [startListening]);

  const exit = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setConversationActive(false);
    void cancelVoiceRecording(LFM2_VOICE_PROVIDER_ID).catch(() => {});
    void stopVoicePlayback().catch(() => {});
    setPhase("idle");
    setError(null);
  }, [setPhase]);

  const primaryAction = useCallback(() => {
    switch (phaseRef.current) {
      case "idle":
        void startListening();
        break;
      case "listening":
        void finishListening();
        break;
      case "thinking":
      case "speaking":
        interrupt();
        break;
      case "transcribing":
        break; // mid-flight; ignore taps
    }
  }, [finishListening, interrupt, startListening]);

  // Speak the agent's reply once the turn completes, then continue/idle.
  useEffect(() => {
    return onAgentTurnComplete(({ tabId, text }) => {
      if (!activeRef.current || phaseRef.current !== "thinking") return;
      if (tabIdRef.current && tabId !== tabIdRef.current) return;
      const spoken = capSpokenText(text, optionsRef.current.maxSpokenChars);
      if (!spoken) {
        goIdleOrContinue();
        return;
      }
      setPhase("speaking");
      void speakVoice(spoken).catch(() => {
        if (activeRef.current && phaseRef.current === "speaking") {
          goIdleOrContinue();
        }
      });
    });
  }, [goIdleOrContinue, setPhase]);

  // Advance the loop when the spoken reply finishes playing.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("voice://playback-finished", () => {
      if (activeRef.current && phaseRef.current === "speaking") {
        goIdleOrContinue();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [goIdleOrContinue]);

  // Tear down recording/playback if we unmount mid-conversation.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        setConversationActive(false);
        void cancelVoiceRecording(LFM2_VOICE_PROVIDER_ID).catch(() => {});
        void stopVoicePlayback().catch(() => {});
      }
    };
  }, []);

  return { active, phase, error, enter, exit, primaryAction };
}
