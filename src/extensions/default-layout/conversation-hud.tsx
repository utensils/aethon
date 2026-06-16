import type { ConversationPhase } from "../../hooks/useVoiceConversation";

const STATUS_LABEL: Record<ConversationPhase, string> = {
  idle: "Tap speak, then talk",
  listening: "Listening…",
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
  onPrimary: () => void;
  onExit: () => void;
}

/** Compact in-composer panel for the LFM2-Audio conversation voice mode:
 *  shows the current phase plus a context-aware primary action and an exit. */
export function ConversationHud({
  phase,
  error,
  onPrimary,
  onExit,
}: ConversationHudProps) {
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
        {error ?? STATUS_LABEL[phase]}
      </span>
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
