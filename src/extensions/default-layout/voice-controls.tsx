import type { VoiceConversationController } from "../../hooks/useVoiceConversation";
import type { VoiceInputController } from "../../hooks/useVoiceInput";
import { VoiceMeter } from "./voice-meter";

export function VoiceStatus({
  voice,
  useDynamicMeter,
  errorOpensSettings,
  onOpenSettings,
}: {
  voice: VoiceInputController;
  useDynamicMeter: boolean;
  errorOpensSettings: boolean;
  onOpenSettings: () => void;
}) {
  if (voice.state === "recording") {
    return (
      <div className="a2ui-chat-input-voice-status">
        <VoiceMeter
          elapsedSeconds={voice.elapsedSeconds}
          useDynamicMeter={useDynamicMeter}
        />
      </div>
    );
  }
  if (voice.state === "starting" || voice.state === "transcribing") {
    return (
      <div className="a2ui-chat-input-voice-status" aria-live="polite">
        <SpinnerIcon />
        <span>
          {voice.state === "starting"
            ? "Starting..."
            : voice.activeProvider?.name
              ? `Transcribing with ${voice.activeProvider.name}`
              : "Transcribing..."}
        </span>
      </div>
    );
  }
  if (voice.state === "error" && voice.error) {
    return (
      <button
        type="button"
        className="a2ui-chat-input-voice-error"
        onClick={errorOpensSettings ? onOpenSettings : voice.cancel}
        title={voice.error}
      >
        <span aria-hidden="true">!</span>
        <span>{voice.error}</span>
      </button>
    );
  }
  if (voice.state === "setup-required" && voice.error) {
    return (
      <button
        type="button"
        className="a2ui-chat-input-voice-error"
        onClick={onOpenSettings}
        title={voice.error}
      >
        <span aria-hidden="true">!</span>
        <span>{voice.error}</span>
      </button>
    );
  }
  return null;
}

export function VoiceInputButton({
  voice,
  disabled,
}: {
  voice: VoiceInputController;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`a2ui-chat-input-voice ${voice.state === "recording" ? "a2ui-chat-input-voice-recording" : ""} ${
        voice.state === "starting" || voice.state === "transcribing"
          ? "a2ui-chat-input-voice-busy"
          : ""
      }`}
      onClick={() => {
        if (voice.state === "recording") voice.stop();
        else if (voice.state === "starting" || voice.state === "transcribing") {
          voice.cancel();
        } else {
          void voice.start();
        }
      }}
      disabled={disabled}
      aria-label={voiceButtonLabel(voice.state)}
      title={voiceButtonLabel(voice.state)}
    >
      {voice.state === "starting" || voice.state === "transcribing" ? (
        <SpinnerIcon />
      ) : voice.state === "recording" ? (
        <StopVoiceIcon />
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

export function VoiceConversationButton({
  conversation,
  disabled,
}: {
  conversation: VoiceConversationController;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`a2ui-chat-input-voice a2ui-chat-input-conversation ${
        conversation.active ? "a2ui-chat-input-conversation-active" : ""
      }`}
      onClick={() =>
        conversation.active ? conversation.exit() : conversation.enter()
      }
      disabled={disabled}
      aria-label={
        conversation.active
          ? "Exit voice conversation"
          : "Start voice conversation"
      }
      title={
        conversation.active
          ? "Exit voice conversation"
          : "Start voice conversation"
      }
    >
      <ConversationIcon />
    </button>
  );
}

function voiceButtonLabel(state: VoiceInputController["state"]): string {
  if (state === "recording") return "Stop voice input";
  if (state === "starting") return "Cancel voice input";
  if (state === "transcribing") return "Cancel transcription";
  return "Voice input";
}

function ConversationIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h6A1.5 1.5 0 0 1 11 4.5v3A1.5 1.5 0 0 1 9.5 9H6L3.5 11V9A1.5 1.5 0 0 1 2 7.5v-3Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 11.5A1.5 1.5 0 0 0 8 13h3l1.5 1.5V13A1.5 1.5 0 0 0 14 11.5V9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.25a2.25 2.25 0 0 0-2.25 2.25V8a2.25 2.25 0 0 0 4.5 0V4.5A2.25 2.25 0 0 0 8 2.25Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.45"
      />
      <path
        d="M3.75 7.25V8a4.25 4.25 0 0 0 8.5 0v-.75M8 12.25v1.5M5.75 13.75h4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.45"
      />
    </svg>
  );
}

function StopVoiceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="a2ui-chat-input-voice-spinner"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M8 2.25a5.75 5.75 0 1 1-5.16 3.22"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
