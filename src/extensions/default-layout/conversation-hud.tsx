import type { ConversationPhase } from "../../hooks/useVoiceConversation";

const STATUS_LABEL: Record<ConversationPhase, string> = {
  idle: "Paused — tap to talk",
  listening: "Listening… (pause when done)",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const PRIMARY_LABEL: Record<ConversationPhase, string> = {
  idle: "Speak",
  listening: "Done",
  transcribing: "…",
  thinking: "Stop",
  speaking: "Stop",
};

export interface ConversationHudProps {
  phase: ConversationPhase;
  error: string | null;
  /** Live partial transcript while listening (cascade engine only). */
  interim?: string | null;
  /** Last time-to-first-audio measurement in ms (cascade, debug builds). */
  latencyMs?: number | null;
  /** Hands-free auto-reopen of the mic after the agent speaks. */
  autoListen: boolean;
  onPrimary: () => void;
  onToggleAutoListen: () => void;
  onExit: () => void;
}

/** Compact in-composer panel for the conversation voice mode: shows the
 *  current phase (or the live partial transcript while listening) plus a
 *  context-aware primary action, an auto-listen toggle, and an exit. */
export function ConversationHud({
  phase,
  error,
  interim,
  latencyMs,
  autoListen,
  onPrimary,
  onToggleAutoListen,
  onExit,
}: ConversationHudProps) {
  const status =
    error ??
    (phase === "listening" && interim ? `“${interim}”` : STATUS_LABEL[phase]);
  return (
    <div
      className="a2ui-conversation-hud"
      role="group"
      aria-label="Voice conversation"
    >
      <span
        className={`a2ui-conversation-hud-dot a2ui-conversation-hud-${phase}`}
        aria-hidden="true"
      />
      <span className="a2ui-conversation-hud-status" aria-live="polite">
        {status}
      </span>
      {typeof latencyMs === "number" && (
        <span
          className="a2ui-conversation-hud-latency"
          title="Time from reply start to first audio"
        >
          {(latencyMs / 1000).toFixed(1)}s
        </span>
      )}
      <button
        type="button"
        className={`a2ui-conversation-hud-auto${
          autoListen ? " a2ui-conversation-hud-auto-on" : ""
        }`}
        role="switch"
        aria-checked={autoListen}
        onClick={onToggleAutoListen}
        title={
          autoListen
            ? "Auto-listen on — mic reopens after each reply. Click for push-to-talk only."
            : "Auto-listen off — push-to-talk for each turn. Click to go hands-free."
        }
      >
        Auto
      </button>
      <button
        type="button"
        className="a2ui-conversation-hud-primary"
        disabled={phase === "transcribing"}
        onClick={onPrimary}
      >
        {PRIMARY_LABEL[phase]}
      </button>
      <button
        type="button"
        className="a2ui-conversation-hud-exit"
        onClick={onExit}
        aria-label="Exit voice conversation"
        title="Exit voice conversation"
      >
        Exit
      </button>
    </div>
  );
}
