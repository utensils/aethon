import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelConvoSpeech,
  endConvoSpeech,
  forceConvoEndTurn,
  sendVoiceBridgeMessage,
  speakConvoChunk,
  startVoiceConvo,
  stopVoiceConvo,
  voiceConvoStatus,
} from "../services/voiceConvo";
import { onAgentTurnComplete } from "../utils/agentTurnEvents";
import { setConversationActive } from "../utils/conversationMode";
import {
  createSpeechChunker,
  stripForSpeechSource,
} from "../utils/speechChunker";
import {
  onVoiceBrainDelta,
  onVoiceBrainEnd,
  onVoiceBrainError,
} from "../utils/voiceBrainEvents";
import type {
  ConversationPhase,
  VoiceConversationController,
} from "./useVoiceConversation";

/** Context stamped onto every `voice_turn` so the brain's dispatch_task tool
 *  has real arguments. Resolved lazily — the active tab/project can change
 *  mid-conversation. */
export interface VoiceConvoContext {
  activeTabId?: string;
  projectPath?: string;
  defaultModel?: string;
  brainModel?: string;
}

export interface UseCascadeConversationOptions {
  getContext: () => VoiceConvoContext;
}

/** Rust ConversationEngine state (voice://convo/state payloads). */
type EngineState =
  | "idle"
  | "listening"
  | "user-speaking"
  | "awaiting-brain"
  | "speaking";

const PHASE_FOR_STATE: Record<EngineState, ConversationPhase> = {
  idle: "idle",
  listening: "listening",
  "user-speaking": "listening",
  "awaiting-brain": "thinking",
  speaking: "speaking",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cascade voice conversation: streaming STT with semantic turn detection
 *  (Rust `voice/convo/` engine) → voice-brain session on the bridge →
 *  streaming TTS. This hook is the glue: it forwards engine turn events to
 *  the brain, feeds brain deltas back as clause-sized speech chunks, and
 *  announces completed work-agent tasks.
 *
 *  Mounted unconditionally next to the LFM2 loop (rules of hooks); completely
 *  inert — no IPC — until `enter()` is called. */
export function useCascadeConversation(
  options: UseCascadeConversationOptions,
): VoiceConversationController {
  const [active, setActive] = useState(false);
  const [phase, setPhaseState] = useState<ConversationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const activeRef = useRef(false);
  const phaseRef = useRef<ConversationPhase>("idle");
  const optionsRef = useRef(options);
  const chunkerRef = useRef(createSpeechChunker());
  /** Task tabs the brain dispatched, awaiting a completion announcement
   *  (announced once, then dropped). */
  const dispatchedRef = useRef(new Map<string, string>());
  useEffect(() => {
    optionsRef.current = options;
  });

  const setPhase = useCallback((next: ConversationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const abortBrain = useCallback(() => {
    chunkerRef.current.reset();
    sendVoiceBridgeMessage({ type: "voice_brain_abort" });
  }, []);

  const startEngine = useCallback(async () => {
    setError(null);
    try {
      await startVoiceConvo();
      if (!activeRef.current) {
        await stopVoiceConvo().catch(() => {});
        return;
      }
      setPhase("listening");
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("idle");
    }
  }, [setPhase]);

  const enter = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    setConversationActive(true);
    void startEngine();
  }, [startEngine]);

  const exit = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setConversationActive(false);
    chunkerRef.current.reset();
    dispatchedRef.current.clear();
    setInterimText(null);
    setPhase("idle");
    setError(null);
    void stopVoiceConvo().catch(() => {});
    sendVoiceBridgeMessage({ type: "voice_session_reset" });
  }, [setPhase]);

  const interrupt = useCallback(() => {
    abortBrain();
    void cancelConvoSpeech().catch(() => {});
  }, [abortBrain]);

  const primaryAction = useCallback(() => {
    switch (phaseRef.current) {
      case "idle":
        // The engine died (error) while the HUD stayed open — retry.
        void startEngine();
        break;
      case "listening":
        void forceConvoEndTurn().catch(() => {});
        break;
      case "thinking":
      case "speaking":
        interrupt();
        break;
      case "transcribing":
        break; // unused by the cascade engine
    }
  }, [interrupt, startEngine]);

  // Push-to-talk: the cascade mic is always open while listening, so the
  // press only matters as an interrupt (barge-in by key) and the release as
  // an explicit end-of-turn.
  const beginHold = useCallback(() => {
    if (!activeRef.current) return;
    if (phaseRef.current === "speaking" || phaseRef.current === "thinking") {
      interrupt();
    }
  }, [interrupt]);

  const endHold = useCallback(() => {
    if (!activeRef.current) return;
    if (phaseRef.current === "listening") {
      void forceConvoEndTurn().catch(() => {});
    }
  }, []);

  // ── Engine events (Rust → hook) ────────────────────────────────────────
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    let cancelled = false;
    const subscribe = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, ({ payload }) => {
        if (!activeRef.current) return;
        handler(payload);
      }).then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      });
    };

    subscribe<{ state: EngineState; reason?: string }>(
      "voice://convo/state",
      (payload) => {
        const next = PHASE_FOR_STATE[payload.state] ?? "idle";
        if (payload.reason === "barge-in") {
          // The user talked over the reply: the engine already cut playback;
          // silence the brain so a stale reply can't resume.
          abortBrain();
        }
        if (next !== "listening") setInterimText(null);
        setPhase(next);
      },
    );
    subscribe<{ text: string }>("voice://convo/interim", (payload) => {
      setInterimText(payload.text || null);
    });
    subscribe<{ transcript: string }>("voice://convo/turn", (payload) => {
      setInterimText(null);
      const context = optionsRef.current.getContext();
      sendVoiceBridgeMessage({
        type: "voice_turn",
        text: payload.transcript,
        context,
      });
    });
    subscribe<{ message: string }>("voice://convo/error", (payload) => {
      setError(payload.message);
    });
    subscribe<{ stage: string; ms: number }>(
      "voice://convo/metrics",
      (payload) => {
        if (payload.stage === "tts-first-audio") setLatencyMs(payload.ms);
      },
    );

    return () => {
      cancelled = true;
      unlistens.forEach((fn) => fn());
    };
  }, [abortBrain, setPhase]);

  // ── Brain events (bridge → hook) ───────────────────────────────────────
  useEffect(() => {
    const offDelta = onVoiceBrainDelta(({ text }) => {
      if (!activeRef.current) return;
      for (const chunk of chunkerRef.current.push(text)) {
        void speakConvoChunk(chunk).catch(() => {});
      }
    });
    const offEnd = onVoiceBrainEnd(({ dispatched }) => {
      if (!activeRef.current) return;
      if (dispatched) {
        dispatchedRef.current.set(dispatched.tabId, dispatched.label);
      }
      // Speak whatever the chunker still buffers (the reply tail that never
      // hit a clause boundary), then seal the utterance. A reply with no
      // speakable text still needs the seal — it unwedges awaiting-brain.
      const rest = chunkerRef.current.flush();
      if (rest) {
        void speakConvoChunk(rest).catch(() => {});
      }
      void endConvoSpeech().catch(() => {});
    });
    const offError = onVoiceBrainError(({ message }) => {
      if (!activeRef.current) return;
      setError(message);
      chunkerRef.current.reset();
      // Unwedge the engine (awaiting-brain → listening).
      void cancelConvoSpeech().catch(() => {});
    });
    return () => {
      offDelta();
      offEnd();
      offError();
    };
  }, []);

  // ── Work-agent completion → spoken announcement ────────────────────────
  useEffect(() => {
    return onAgentTurnComplete(({ tabId, text }) => {
      if (!activeRef.current) return;
      const label = dispatchedRef.current.get(tabId);
      if (label === undefined) return;
      // Announce once per dispatch; later turns on that tab are the user's.
      dispatchedRef.current.delete(tabId);
      sendVoiceBridgeMessage({
        type: "voice_task_event",
        taskTabId: tabId,
        label,
        status: "completed",
        finalText: stripForSpeechSource(text),
      });
    });
  }, []);

  // Tear down the engine if we unmount mid-conversation.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        setConversationActive(false);
        void stopVoiceConvo().catch(() => {});
      }
    };
  }, []);

  return {
    active,
    phase,
    error,
    interimText,
    latencyMs,
    enter,
    exit,
    primaryAction,
    beginHold,
    endHold,
  };
}

/** Resolve `[voice] conversation_engine` to a concrete pipeline. `"auto"`
 *  asks the Rust engine whether the cascade's provider keys resolve and
 *  falls back to the local LFM2 loop when they don't (or when the probe
 *  fails — e.g. a non-voice build). */
export function useConversationEngineChoice(
  configured: string | undefined,
): "cascade" | "lfm2" {
  // Explicit choices resolve synchronously in render; only "auto" needs the
  // async availability probe.
  const [autoChoice, setAutoChoice] = useState<"cascade" | "lfm2">("lfm2");
  const isAuto = configured !== "cascade" && configured !== "lfm2";
  useEffect(() => {
    if (!isAuto) return;
    let cancelled = false;
    voiceConvoStatus()
      .then((status) => {
        if (!cancelled) setAutoChoice(status.available ? "cascade" : "lfm2");
      })
      .catch(() => {
        if (!cancelled) setAutoChoice("lfm2");
      });
    return () => {
      cancelled = true;
    };
  }, [isAuto]);
  if (configured === "cascade") return "cascade";
  if (configured === "lfm2") return "lfm2";
  return autoChoice;
}
