import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type {
  ChatAttachment,
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import {
  resolveBoolean,
  resolveNumber,
  resolveString,
} from "../../utils/dataBinding";
import { useExtensionRegistry } from "../ExtensionRegistry";
import type { QueuedMessage } from "../../types/tab";
import { SlashPicker } from "./slash-picker";
import { useComposerResize } from "./use-composer-resize";
import { useDraftCommit } from "./use-draft-commit";
import { useVoiceHotkey } from "../../hooks/useVoiceHotkey";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import {
  insertTranscriptAtSelection,
  shouldOpenVoiceSettingsForError,
} from "../../utils/voice";
import { VoiceMeter } from "./voice-meter";
import {
  type ArgMatch,
  type CommandMatch,
  type PickerMatch,
  type SlashCommandSource,
  useSlashMatching,
} from "./use-slash-matching";
import { ImageLightbox } from "./image-lightbox";
import { imageAttachmentSrc } from "../../utils/imageAttachments";

export function ChatInput({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const extensionRegistry = useExtensionRegistry();
  const QueuedPopover = extensionRegistry.resolve("queued-messages-popover");
  const props = component.props as {
    value?: StringValue;
    placeholder?: StringValue;
    disabled?: BooleanValue;
    onSubmit?: string;
    onChange?: string;
    commands?: SlashCommandSource;
    queueCount?: NumberValue;
    sendLabel?: StringValue;
    stopLabel?: StringValue;
    stopTitle?: StringValue;
    queueBadgeFormat?: StringValue;
  };

  const externalValue = props.value ? resolveString(props.value, state) : "";
  const {
    value,
    setValue,
    commitDraft,
    scheduleDraftCommit,
  } = useDraftCommit(externalValue, onEvent);
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const busy = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const queueCount = props.queueCount
    ? resolveNumber(props.queueCount, state)
    : 0;
  const queuedMessages =
    (state.queuedMessages as QueuedMessage[] | undefined) ?? [];
  const attachments =
    (state.draftAttachments as ChatAttachment[] | undefined) ?? [];
  const canSteerQueuedMessage = queuedMessages.length > 0 || queueCount > 0;
  const sendLabel = props.sendLabel
    ? resolveString(props.sendLabel, state)
    : "Send";
  const stopLabel = props.stopLabel
    ? resolveString(props.stopLabel, state)
    : "Stop";
  const stopTitle = props.stopTitle
    ? resolveString(props.stopTitle, state)
    : "Stop the current prompt";
  const queuedMessageLabel = `${queueCount} message${queueCount === 1 ? "" : "s"} queued`;
  const effectiveStopLabel =
    queueCount > 0 && !props.stopLabel ? "Stop + clear" : stopLabel;
  const effectiveStopTitle =
    queueCount > 0
      ? `Stop the current prompt and clear ${queuedMessageLabel}`
      : stopTitle;
  const queueBadgeFormat = props.queueBadgeFormat
    ? resolveString(props.queueBadgeFormat, state)
    : "+{n}";

  const {
    slashMatch,
    highlightIdx,
    setHighlightIdx,
    dismissPicker,
  } = useSlashMatching({
    value,
    commandsRaw: props.commands,
    state,
  });
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { composerHeight, startComposerResize } = useComposerResize();
  const insertTranscript = useCallback(
    (transcript: string) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? value.length;
      const end = textarea?.selectionEnd ?? value.length;
      const next = insertTranscriptAtSelection(
        textarea?.value ?? value,
        transcript,
        start,
        end,
      );
      setValue(next.text);
      commitDraft(next.text);
      requestAnimationFrame(() => {
        const current = textareaRef.current;
        if (!current) return;
        current.focus();
        current.selectionStart = current.selectionEnd = next.cursor;
      });
    },
    [commitDraft, setValue, value],
  );
  const voice = useVoiceInput(insertTranscript, (providerId) => {
    onEvent("voice:setup", { providerId });
  });
  const voiceState = voice.state;
  const cancelVoice = voice.cancel;
  const voiceConfig = (state.voice as
    | { toggleHotkey?: string | null; holdHotkey?: string | null }
    | undefined) ?? { toggleHotkey: "mod+shift+m", holdHotkey: null };
  const settings = state.settings as { open?: boolean } | undefined;
  const palette = state.commandPalette as { open?: boolean } | undefined;
  const search = state.search as { open?: boolean } | undefined;
  const voiceInputBlocked =
    !!settings?.open || !!palette?.open || !!search?.open;
  const voiceInputBlockedRef = useRef(voiceInputBlocked);
  useLayoutEffect(() => {
    voiceInputBlockedRef.current = voiceInputBlocked;
  }, [voiceInputBlocked]);
  const isVoiceInputBlocked = useCallback(
    () => voiceInputBlockedRef.current,
    [],
  );
  useVoiceHotkey(
    voice,
    voiceConfig.toggleHotkey ?? "mod+shift+m",
    voiceConfig.holdHotkey ?? null,
    isVoiceInputBlocked,
  );
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) =>
      setReducedMotion(event.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => {
    if (voiceState !== "recording") return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoice();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [voiceState, cancelVoice]);
  const useDynamicMeter =
    !reducedMotion && voice.activeProvider?.recordingMode === "native";
  const voiceErrorOpensSettings = shouldOpenVoiceSettingsForError(
    voice.activeProvider,
  );

  const insertMatch = (m: PickerMatch) => {
    const text =
      m.kind === "command"
        ? `/${m.cmd.name} `
        : `/${m.cmd.name} ${m.choice.value}`;
    setValue(text);
    commitDraft(text);
  };

  const submitPayload = (value: string, mode: "normal" | "steer") => ({
    value,
    mode,
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  const submitArgMatch = (match: ArgMatch) => {
    const submitText = `/${match.cmd.name} ${match.choice.value}`;
    setValue(submitText);
    commitDraft(submitText);
    onEvent("submit", submitPayload(submitText, "normal"));
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    scheduleDraftCommit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const submit = (mode: "normal" | "steer") => {
      if (voice.state === "recording" || voice.state === "starting") {
        voice.cancel();
      }
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length === 0 && attachments.length === 0) {
        if (mode === "steer" && canSteerQueuedMessage) {
          onEvent("submit", submitPayload("", mode));
        }
        return;
      }
      commitDraft(v);
      onEvent("submit", submitPayload(v, mode));
    };

    if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit("steer");
      return;
    }

    if (slashMatch) {
      const list = slashMatch.matches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const match = list[highlightIdx] ?? list[0];
        if (match) insertMatch(match);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissPicker();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = (e.target as HTMLTextAreaElement).value;
        if (slashMatch.mode === "arg") {
          const match = list[highlightIdx] ?? list[0];
          if (match) submitArgMatch(match as ArgMatch);
          return;
        }
        const exact = (list as CommandMatch[]).find(
          (c) => v === `/${c.cmd.name}` || v.startsWith(`/${c.cmd.name} `),
        );
        if (exact && v.trim().length > 0) {
          onEvent("submit", submitPayload(v, "normal"));
          return;
        }
        const match = list[highlightIdx] ?? list[0];
        if (match) insertMatch(match);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit("normal");
    }
  };

  const handleClick = () => {
    if (value.trim().length > 0 || attachments.length > 0) {
      if (voice.state === "recording" || voice.state === "starting") {
        voice.cancel();
      }
      commitDraft(value);
      onEvent("submit", submitPayload(value, "normal"));
    }
  };

  const handleStop = () => {
    onEvent("cancel");
  };

  return (
    <div
      className="a2ui-chat-input"
      ref={inputContainerRef}
      style={{ "--composer-height": `${composerHeight}px` } as CSSProperties}
    >
      <div
        className="a2ui-chat-input-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        title="Drag to resize composer"
        onMouseDown={startComposerResize}
      />
      {QueuedPopover
        ? createElement(QueuedPopover, {
            component: {
              id: "queued-messages-popover",
              type: "queued-messages-popover",
            },
            state,
            onEvent,
          })
        : null}
      <SlashPicker
        anchorRef={inputContainerRef}
        slashMatch={slashMatch}
        highlightIdx={highlightIdx}
        setHighlightIdx={setHighlightIdx}
        onInsert={insertMatch}
        onSubmitArg={submitArgMatch}
      />
      {busy && (
        <div className="a2ui-chat-input-hint">
          <span>Enter queues</span>
          <span>
            {canSteerQueuedMessage
              ? "Cmd/Ctrl+Enter steers latest queued"
              : "Cmd/Ctrl+Enter steers"}
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <AttachmentTray
          attachments={attachments}
          onRemove={(id) => onEvent("attachment:remove", { id })}
        />
      )}
      <div className="a2ui-chat-input-field-wrap">
        <textarea
          ref={textareaRef}
          className="a2ui-chat-input-field"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {queueCount > 0 && (
          <span
            className="a2ui-chat-input-queue"
            title={`${queuedMessageLabel} behind the current prompt`}
          >
            {queueBadgeFormat.replace("{n}", String(queueCount))}
          </span>
        )}
        <VoiceStatus
          voice={voice}
          useDynamicMeter={useDynamicMeter}
          errorOpensSettings={voiceErrorOpensSettings}
          onOpenSettings={() =>
            onEvent("voice:setup", { providerId: voice.activeProvider?.id })
          }
        />
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
          disabled={busy}
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
        {busy ? (
          <button
            type="button"
            className="a2ui-chat-input-send a2ui-chat-input-stop"
            onClick={handleStop}
            title={effectiveStopTitle}
            aria-label={effectiveStopLabel}
          >
            <svg
              className="a2ui-chat-input-send-icon"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <rect
                x="3"
                y="3"
                width="10"
                height="10"
                rx="1.5"
                fill="currentColor"
              />
            </svg>
            <span className="a2ui-chat-input-send-label">
              {effectiveStopLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="a2ui-chat-input-send"
            onClick={handleClick}
            disabled={value.trim().length === 0 && attachments.length === 0}
            aria-label={sendLabel}
            title={`${sendLabel} (Enter)`}
          >
            <svg
              className="a2ui-chat-input-send-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 8l11-5-4 11-2-5-5-1z" />
            </svg>
            <span className="a2ui-chat-input-send-label">{sendLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
}

type VoiceView = ReturnType<typeof useVoiceInput>;

function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState<ChatAttachment | null>(null);
  return (
    <>
      <div className="a2ui-chat-attachments" aria-label="Attached images">
        {attachments.map((attachment) => (
          <figure className="a2ui-chat-attachment" key={attachment.id}>
            <button
              type="button"
              className="a2ui-chat-attachment-thumb"
              aria-label={`Open ${attachment.name}`}
              onClick={() => setOpen(attachment)}
            >
              <img src={imageAttachmentSrc(attachment)} alt="" />
            </button>
            <figcaption title={attachment.name}>{attachment.name}</figcaption>
            <button
              type="button"
              className="a2ui-chat-attachment-remove"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => onRemove(attachment.id)}
            >
              ×
            </button>
          </figure>
        ))}
      </div>
      {open && (
        <ImageLightbox attachment={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

function VoiceStatus({
  voice,
  useDynamicMeter,
  errorOpensSettings,
  onOpenSettings,
}: {
  voice: VoiceView;
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

function voiceButtonLabel(state: VoiceView["state"]): string {
  if (state === "recording") return "Stop voice input";
  if (state === "starting") return "Cancel voice input";
  if (state === "transcribing") return "Cancel transcription";
  return "Voice input";
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
