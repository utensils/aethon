import {
  createElement,
  useEffect,
  useMemo,
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
import type { QueuedMessage, Tab } from "../../types/tab";
import { SlashPicker } from "./slash-picker";
import { AtPicker } from "./at-picker";
import { atMentionRoot } from "./at-mention";
import { useAtMentionTextarea } from "./use-at-mention-textarea";
import { useComposerResize } from "./use-composer-resize";
import { useDraftCommit } from "./use-draft-commit";
import { useVoiceConversation } from "../../hooks/useVoiceConversation";
import { activeWorkspaceCwd } from "../../utils/activeWorkspaceRoot";
import { ConversationHud } from "./conversation-hud";
import {
  VoiceConversationButton,
  VoiceInputButton,
  VoiceStatus,
} from "./voice-controls";
import {
  type ArgMatch,
  type CommandMatch,
  type PickerMatch,
  type SlashCommandSource,
  useSlashMatching,
} from "./use-slash-matching";
import { ImageAttachmentImage } from "./image-attachment-image";
import { ImageLightbox } from "./image-lightbox";
import { useTextareaVoiceInput } from "./use-textarea-voice-input";

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
  const { value, setValue, commitDraft, scheduleDraftCommit } = useDraftCommit(
    externalValue,
    onEvent,
  );
  const placeholder = props.placeholder
    ? resolveString(props.placeholder, state)
    : "";
  const busy = props.disabled ? resolveBoolean(props.disabled, state) : false;
  const queueCount = props.queueCount
    ? resolveNumber(props.queueCount, state)
    : 0;
  const queuedMessages =
    (state.queuedMessages as QueuedMessage[] | undefined) ?? [];
  const attachments = useMemo(
    () => (state.draftAttachments as ChatAttachment[] | undefined) ?? [],
    [state.draftAttachments],
  );
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

  const { slashMatch, highlightIdx, setHighlightIdx, dismissPicker } =
    useSlashMatching({
      value,
      commandsRaw: props.commands,
      state,
    });
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { composerHeight, startComposerResize } = useComposerResize();
  const chatAtMentionHostId =
    (state.project as { hostId?: string } | undefined)?.hostId ?? null;
  const {
    atMatch,
    atHighlightIdx,
    setAtHighlightIdx,
    setCursor,
    insertAtMention,
    handleAtMentionKeyDown,
  } = useAtMentionTextarea({
    value,
    setValue,
    onValueCommit: commitDraft,
    textareaRef,
    root: atMentionRoot(state),
    hostId: chatAtMentionHostId,
    // The slash picker owns the keyboard while it's open; `/command @arg`
    // drafts stay slash-flavored.
    enabled: !slashMatch,
  });
  const voiceSurfaceVisible = !!state.agentTabActive;
  const voiceConfig = (state.voice as
    | {
        toggleHotkey?: string | null;
        holdHotkey?: string | null;
        speakMaxChars?: number;
        conversationContinuous?: boolean;
        conversationEngine?: string;
        brainModel?: string | null;
      }
    | undefined) ?? { toggleHotkey: "mod+shift+m", holdHotkey: null };
  // Latest state for event-time context resolution (mirrors optionsRef in
  // the conversation hooks — refs must not be written during render).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const conversation = useVoiceConversation({
    submitText: (text) => onEvent("submit", { value: text, mode: "normal" }),
    getActiveTabId: () => state.activeTabId as string | undefined,
    continuous: voiceConfig.conversationContinuous ?? false,
    maxSpokenChars: voiceConfig.speakMaxChars ?? 600,
    onNeedsSetup: (providerId) => onEvent("voice:setup", { providerId }),
    engine:
      voiceConfig.conversationEngine === "cascade"
        ? "cascade"
        : voiceConfig.conversationEngine === "lfm2"
          ? "lfm2"
          : "auto",
    allowFallback: (voiceConfig.conversationEngine ?? "auto") === "auto",
    getConvoContext: () => {
      const current = stateRef.current;
      const voice = current.voice as { brainModel?: string | null } | undefined;
      const activeTabId =
        typeof current.activeTabId === "string" ? current.activeTabId : undefined;
      const model =
        (typeof current.model === "string" && current.model) ||
        (typeof current.piDefaultModel === "string" && current.piDefaultModel) ||
        undefined;
      // The project list (label + path) lets the brain dispatch to a project
      // the user NAMES even when none is active in the sidebar.
      const knownProjects = (
        (current.projects as { label?: unknown; path?: unknown }[] | undefined) ??
        []
      )
        .flatMap((p) =>
          typeof p.label === "string" && typeof p.path === "string" && p.path
            ? [{ label: p.label, path: p.path }]
            : [],
        )
        .slice(0, 12);
      return {
        ...(activeTabId ? { activeTabId } : {}),
        ...(activeWorkspaceCwd(current)
          ? { projectPath: activeWorkspaceCwd(current) ?? undefined }
          : {}),
        ...(model ? { defaultModel: model } : {}),
        ...(voice?.brainModel ? { brainModel: voice.brainModel } : {}),
        ...(knownProjects.length > 0 ? { knownProjects } : {}),
      };
    },
    getTaskActivity: (tabId) => {
      // A dispatched tab may sit in the visible strip or a backgrounded
      // workspace bucket — check both.
      const current = stateRef.current;
      const buckets = current.persistedTabBuckets as
        | Record<string, { tabs?: Tab[] }>
        | undefined;
      const tab =
        ((current.tabs as Tab[] | undefined) ?? []).find(
          (t) => t.id === tabId,
        ) ??
        Object.values(buckets ?? {})
          .flatMap((bucket) => bucket.tabs ?? [])
          .find((t) => t.id === tabId);
      if (!tab) return null;
      const lastAgentText =
        [...(tab.messages ?? [])]
          .reverse()
          .find((m) => m.role === "agent" && (m.text ?? "").trim().length > 0)
          ?.text ?? "";
      return {
        running: tab.waiting === true || (tab.queueCount ?? 0) > 0,
        recentText: lastAgentText,
      };
    },
  });
  const settings = state.settings as { open?: boolean } | undefined;
  const palette = state.commandPalette as { open?: boolean } | undefined;
  const search = state.search as { open?: boolean } | undefined;
  const { voice, useDynamicMeter, voiceErrorOpensSettings } =
    useTextareaVoiceInput({
      value,
      setValue,
      onValueCommit: commitDraft,
      setCursor,
      textareaRef,
      surfaceActive: voiceSurfaceVisible,
      overlays: {
        settingsOpen: settings?.open,
        paletteOpen: palette?.open,
        searchOpen: search?.open,
      },
      voiceConfig,
      onNeedsSetup: (providerId) => onEvent("voice:setup", { providerId }),
      onAutoSend: (text) => {
        onEvent("submit", {
          value: text,
          mode: "normal",
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      },
      conversation,
    });

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
    setValue("");
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    setCursor(e.target.selectionStart ?? next.length);
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
      setValue("");
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
          setValue("");
          return;
        }
        const match = list[highlightIdx] ?? list[0];
        if (match) insertMatch(match);
        return;
      }
    }
    if (!slashMatch && handleAtMentionKeyDown(e)) return;
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
      setValue("");
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
      <AtPicker
        anchorRef={inputContainerRef}
        atMatch={atMatch}
        highlightIdx={atHighlightIdx}
        setHighlightIdx={setAtHighlightIdx}
        onInsert={insertAtMention}
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
      {conversation.active && (
        <ConversationHud
          phase={conversation.phase}
          error={conversation.error}
          interim={conversation.interimText}
          latencyMs={conversation.latencyMs}
          autoListen={voiceConfig.conversationContinuous ?? false}
          onPrimary={conversation.primaryAction}
          onToggleAutoListen={() =>
            onEvent("voice:auto-listen", {
              value: !(voiceConfig.conversationContinuous ?? false),
            })
          }
          onExit={conversation.exit}
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
          onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
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
        <VoiceInputButton voice={voice} disabled={busy} />
        <VoiceConversationButton
          conversation={conversation}
          disabled={busy && !conversation.active}
        />
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
              <ImageAttachmentImage attachment={attachment} alt="" />
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
