import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelVoiceRecording,
  speakVoice,
  startVoiceRecording,
  stopAndTranscribeVoice,
  stopVoicePlayback,
} from "../services/voice";
import { voiceConvoStatus } from "../services/voiceConvo";
import { onAgentTurnComplete } from "../utils/agentTurnEvents";
import { setConversationActive } from "../utils/conversationMode";
import { LFM2_VOICE_PROVIDER_ID, capSpokenText } from "../utils/voice";
import {
  useCascadeConversation,
  type VoiceConvoContext,
  type VoiceTaskActivity,
} from "./useCascadeConversation";

/** A full turn of the LFM2-Audio conversation loop:
 *  idle → listening → transcribing → thinking → speaking → (continue|idle). */
export type ConversationPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export type ConversationEngineKind = "cascade" | "lfm2";

export interface UseVoiceConversationOptions {
  /** Send the transcript to the agent (reuses the composer submit path). */
  submitText: (text: string) => void;
  /** The tab the conversation is bound to, captured at submit time. */
  getActiveTabId: () => string | undefined;
  /** Hands-free: auto-reopen the mic after the agent finishes speaking so the
   *  user never taps to start the next turn. */
  continuous: boolean;
  /** Cap on spoken reply length (shared with speak-agent-replies). */
  maxSpokenChars: number;
  /** Routed to Settings when the LFM2 model/binary isn't ready. */
  onNeedsSetup?: (providerId: string) => void;
  /** Which pipeline drives the conversation. `"cascade"` is the streaming
   *  engine (useCascadeConversation); `"lfm2"` the local batch loop below;
   *  `"auto"` (default) probes cascade availability at ENTER time — so a key
   *  saved in Settings takes effect on the next conversation, no reload. */
  engine?: ConversationEngineKind | "auto";
  /** Runtime context stamped on cascade voice turns (active tab, project,
   *  models). Required for the cascade engine to dispatch tasks. */
  getConvoContext?: () => VoiceConvoContext;
  /** Live activity of a dispatched task tab, polled for spoken progress
   *  updates while the work agent runs (cascade engine). */
  getTaskActivity?: (tabId: string) => VoiceTaskActivity | null;
  /** When true (engine came from "auto"), a cascade session that dies —
   *  failed start or exhausted reconnects — hands the conversation to the
   *  local LFM2 loop instead of stranding the user with an error. */
  allowFallback?: boolean;
}

export interface VoiceConversationController {
  active: boolean;
  phase: ConversationPhase;
  error: string | null;
  /** Live partial transcript while listening (cascade engine only). */
  interimText: string | null;
  /** Last measured time-to-first-audio for a spoken reply, in ms (cascade
   *  engine, debug builds emit the metric). */
  latencyMs: number | null;
  enter: () => void;
  exit: () => void;
  /** Context-aware tap: start speaking / finish speaking / interrupt. */
  primaryAction: () => void;
  /** Push-to-talk press: open/keep the mic and suppress VAD auto-end so the
   *  user controls when the utterance ends (held key). No-op unless active. */
  beginHold: () => void;
  /** Push-to-talk release: end the held utterance and send it to the agent. */
  endHold: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Route to the configured conversation pipeline. Both hooks mount
 *  unconditionally (rules of hooks); each is inert until entered, so the
 *  inactive one costs a few no-op listeners. */
export function useVoiceConversation(
  options: UseVoiceConversationOptions,
): VoiceConversationController {
  const lfm2 = useLfm2Conversation(options);
  const cascade = useCascadeConversation({
    getContext: options.getConvoContext ?? (() => ({})),
    ...(options.getTaskActivity
      ? { getTaskActivity: options.getTaskActivity }
      : {}),
  });
  const [fellBack, setFellBack] = useState(false);
  // Which pipeline the CURRENT (or most recent) session runs on. "auto"
  // resolves here at enter time via a live availability probe.
  const [resolvedEngine, setResolvedEngine] = useState<ConversationEngineKind>(
    "lfm2",
  );
  const usingCascade = resolvedEngine === "cascade" && !fellBack;

  // A dead cascade session (error while idle-but-active: failed start or
  // exhausted mid-session reconnects) hands off to the local loop when the
  // engine choice was automatic. The switch is spoken through the local TTS
  // so a hands-free user isn't left talking to a dead mic.
  const shouldFallBack =
    options.allowFallback === true &&
    usingCascade &&
    cascade.active &&
    cascade.phase === "idle" &&
    cascade.error !== null;
  const cascadeExit = cascade.exit;
  const lfm2Enter = lfm2.enter;
  useEffect(() => {
    if (!shouldFallBack) return;
    cascadeExit();
    // One-shot engine handoff reacting to the cascade's error state — the
    // set is the transition itself, not a resync loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFellBack(true);
    lfm2Enter();
    void speakVoice(
      "Cloud voice is unavailable, switching to the local engine.",
    ).catch(() => {});
  }, [shouldFallBack, cascadeExit, lfm2Enter]);

  const controller = usingCascade ? cascade : lfm2;
  const cascadeEnter = cascade.enter;
  return {
    ...controller,
    enter: () => {
      const configured = options.engine ?? "auto";
      if (configured === "cascade") {
        setFellBack(false);
        setResolvedEngine("cascade");
        cascadeEnter();
        return;
      }
      if (configured === "lfm2") {
        setResolvedEngine("lfm2");
        lfm2Enter();
        return;
      }
      // Auto: probe availability NOW, so keys/models added since boot count.
      void voiceConvoStatus()
        .then((status) => {
          if (status.available) {
            setFellBack(false);
            setResolvedEngine("cascade");
            cascadeEnter();
          } else {
            setResolvedEngine("lfm2");
            lfm2Enter();
          }
        })
        .catch(() => {
          setResolvedEngine("lfm2");
          lfm2Enter();
        });
    },
    exit: () => {
      controller.exit();
      // The next session gets a fresh shot at the cascade.
      setFellBack(false);
    },
  };
}

// Voice-activity detection thresholds (over the recorder's ~30 Hz
// `voice://level` RMS, where typical speech is ~0.05–0.15). Speech must first
// be detected, then a sustained silence ends the utterance — so the user never
// taps "done". Hysteresis (speech > silence) avoids flapping on word gaps.
const VAD_SPEECH_LEVEL = 0.05;
const VAD_SILENCE_LEVEL = 0.03;
const VAD_SILENCE_HANG_MS = 1100;
// Hard ceiling so a noisy room (level never dipping below silence) still ends
// the turn rather than recording forever.
const VAD_MAX_UTTERANCE_MS = 30_000;

interface VoiceLevel {
  level: number;
}

/** The original LFM2-Audio loop: batch ASR → composer submit → batch TTS. */
function useLfm2Conversation(
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
  // VAD bookkeeping for the current listening window.
  const vadSpokeRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const listenStartAtRef = useRef(0);
  // True while the user holds the push-to-talk key: VAD never auto-ends the
  // utterance, so the release is the sole end-of-message signal.
  const manualHoldRef = useRef(false);
  // True while a push-to-talk press is opening the mic from idle. Lets a
  // release that lands before the recorder is ready finish the moment it opens,
  // instead of stranding the mic in "listening" with no keyup to close it.
  const holdStartRef = useRef(false);
  const finishRef = useRef<() => void>(() => {});
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
      // Arm VAD for this listening window (the level listener drives end-of-
      // utterance, so no manual "done" tap is needed).
      vadSpokeRef.current = false;
      lastSpeechAtRef.current = 0;
      listenStartAtRef.current = Date.now();
      setPhase("listening");
      // If a push-to-talk press opened this window but the key was already
      // released before the recorder became ready, honor that release now —
      // otherwise the mic would stay hot with no keyup left to finish it.
      // Route through finishRef to dodge the startListening↔finishListening
      // useCallback cycle (same indirection the VAD listener uses).
      if (holdStartRef.current) {
        holdStartRef.current = false;
        if (!manualHoldRef.current) finishRef.current();
      }
    } catch (caught) {
      // A failed open must not leave VAD suppressed for the next window.
      manualHoldRef.current = false;
      holdStartRef.current = false;
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
    // Auto-listen (continuous) is hands-free, so open the mic immediately on
    // entry. With it off the user drives every turn — including the first — so
    // land on the paused "tap to talk" state instead of recording on entry.
    if (optionsRef.current.continuous) {
      void startListening();
    } else {
      setPhase("idle");
    }
  }, [setPhase, startListening]);

  const exit = useCallback(() => {
    activeRef.current = false;
    manualHoldRef.current = false;
    holdStartRef.current = false;
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

  // Push-to-talk press. Opens the mic if idle and suppresses VAD so the held
  // key — not silence — decides when the utterance ends. While the agent is
  // thinking/speaking, or mid-transcription, the press is ignored (tap the HUD
  // to interrupt); we only arm the hold when we actually reach listening.
  const beginHold = useCallback(() => {
    if (!activeRef.current) return;
    if (phaseRef.current === "idle") {
      manualHoldRef.current = true;
      holdStartRef.current = true;
      void startListening();
    } else if (phaseRef.current === "listening") {
      manualHoldRef.current = true;
    }
  }, [startListening]);

  // Push-to-talk release. Drops the VAD suppression and ends the utterance,
  // sending whatever was captured (finishListening is a no-op off "listening").
  const endHold = useCallback(() => {
    if (!manualHoldRef.current) return;
    manualHoldRef.current = false;
    if (phaseRef.current === "listening") {
      void finishListening();
    }
  }, [finishListening]);

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

  // Keep the latest finishListening reachable from the VAD listener without
  // re-subscribing the event on every render.
  useEffect(() => {
    finishRef.current = () => void finishListening();
  });

  // Voice-activity detection: end the utterance automatically once the user
  // stops talking. Drives a fluid, hands-free conversation — the mic closes on
  // silence instead of a manual tap. Subscribed once; gated on the listening
  // phase so dictation levels are ignored.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<VoiceLevel>("voice://level", ({ payload }) => {
      if (!activeRef.current || phaseRef.current !== "listening") return;
      const now = Date.now();
      const level = payload?.level ?? 0;
      if (level >= VAD_SPEECH_LEVEL) {
        vadSpokeRef.current = true;
        lastSpeechAtRef.current = now;
        return;
      }
      // While the user holds the push-to-talk key, they own the end-of-message
      // signal — never auto-close on silence or the ceiling.
      if (manualHoldRef.current) return;
      if (!vadSpokeRef.current) return; // wait for speech before arming silence
      const silentLongEnough =
        level < VAD_SILENCE_LEVEL &&
        now - lastSpeechAtRef.current >= VAD_SILENCE_HANG_MS;
      const tooLong = now - listenStartAtRef.current >= VAD_MAX_UTTERANCE_MS;
      if (silentLongEnough || tooLong) {
        finishRef.current();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // If focus leaves while the push-to-talk key is held, the keyup never
  // arrives. Release the hold and END the capture — just dropping the
  // suppression isn't enough: VAD refuses to finish until it has seen speech,
  // so a blur before the user spoke would otherwise wedge the mic open in the
  // background. If the mic is open, finish now; if it's still opening, clearing
  // manualHold lets the deferred open-check (holdStartRef) finish it on open.
  // The conversation itself deliberately keeps running across blur.
  useEffect(() => {
    const onBlur = () => {
      if (!manualHoldRef.current) return;
      manualHoldRef.current = false;
      if (phaseRef.current === "listening") finishRef.current();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

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

  return {
    active,
    phase,
    error,
    interimText: null,
    latencyMs: null,
    enter,
    exit,
    primaryAction,
    beginHold,
    endHold,
  };
}
