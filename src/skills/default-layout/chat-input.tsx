import {
  createElement,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type {
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
import { useSkillRegistry } from "../../skills/SkillRegistry";
import type { QueuedMessage } from "../../types/tab";
import { SlashPicker } from "./slash-picker";
import { useComposerResize } from "./use-composer-resize";
import { useDraftCommit } from "./use-draft-commit";
import {
  type ArgMatch,
  type CommandMatch,
  type PickerMatch,
  type SlashCommandSource,
  useSlashMatching,
} from "./use-slash-matching";

export function ChatInput({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const skillRegistry = useSkillRegistry();
  const QueuedPopover = skillRegistry.resolve("queued-messages-popover");
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
  const { composerHeight, startComposerResize } = useComposerResize();

  const insertMatch = (m: PickerMatch) => {
    const text =
      m.kind === "command"
        ? `/${m.cmd.name} `
        : `/${m.cmd.name} ${m.choice.value}`;
    setValue(text);
    commitDraft(text);
  };

  const submitArgMatch = (match: ArgMatch) => {
    const submitText = `/${match.cmd.name} ${match.choice.value}`;
    setValue(submitText);
    commitDraft(submitText);
    onEvent("submit", { value: submitText, mode: "normal" });
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    scheduleDraftCommit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const submit = (mode: "normal" | "steer") => {
      const v = (e.target as HTMLTextAreaElement).value;
      if (v.trim().length === 0) {
        if (mode === "steer" && canSteerQueuedMessage) {
          onEvent("submit", { value: "", mode });
        }
        return;
      }
      commitDraft(v);
      onEvent("submit", { value: v, mode });
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
          onEvent("submit", { value: v, mode: "normal" });
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
    if (value.trim().length > 0) {
      commitDraft(value);
      onEvent("submit", { value, mode: "normal" });
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
      <div className="a2ui-chat-input-field-wrap">
        <textarea
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
            disabled={value.trim().length === 0}
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
