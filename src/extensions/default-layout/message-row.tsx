import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ChatAttachment, ChatMessage } from "../../types/a2ui";
import A2UIRenderer, {
  type BuiltinComponentProps,
} from "../../components/A2UIRenderer";
import { splitThinkingBlocks } from "../../utils/thinkingBlocks";
import { normalizeAgentMessageForDisplay } from "../../utils/agentResponseNormalizer";
import type { VisibilityMode } from "../../config";
import {
  CHAT_MARKDOWN_PROPS,
  CHAT_STREAMING_MARKDOWN_PROPS,
} from "./markdown-adapter";
import { ImageAttachmentImage } from "./image-attachment-image";
import { ImageLightbox } from "./image-lightbox";
import { forwardNestedA2UIEvent } from "./message-rendering-utils";

const FENCED_CODE_MARKER_RE = /(^|\n)(```|~~~)/;

// Top-level state keys that change identity on every streamed token — the
// active tab's `messages` array and the `tabs` array that nests it (both
// rewritten by `updateTab` / TAB_MIRROR_KEYS on each delta). Historical chat
// rows never read these, so the row memo can ignore them: an already-rendered
// A2UI row stays put across a streaming turn instead of reconciling the whole
// list on every token (#159 chat-lag fix).
const VOLATILE_ROW_STATE_KEYS: ReadonlySet<string> = new Set([
  "messages",
  "tabs",
]);

/** Shallow equality of two state records, ignoring `exclude`d keys. Lets the
 *  chat-row memo bail when only the per-token-volatile `messages`/`tabs` keys
 *  changed. Cheap (a ~15-key reference scan) and only reached after the
 *  cheaper message/onEvent identity checks already passed. */
function shallowEqualExcept(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  exclude: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a)) {
    if (exclude.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  // Catch retained keys that exist only in `b` (added since the last render).
  for (const key of Object.keys(b)) {
    if (exclude.has(key)) continue;
    if (!(key in a)) return false;
  }
  return true;
}

export function TypingIndicator() {
  return (
    <div
      role="status"
      aria-label="Agent is thinking"
      className="ae-typing-indicator"
    >
      <span className="ae-typing-dots" aria-hidden="true">
        <span className="ae-typing-dot" />
        <span className="ae-typing-dot" />
        <span className="ae-typing-dot" />
      </span>
    </div>
  );
}

function sidebarModelLabel(
  state: Record<string, unknown>,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  const sidebar = state.sidebar;
  if (!sidebar || typeof sidebar !== "object") return undefined;
  const models = (sidebar as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const match = models.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { id?: unknown }).id === model;
  });
  if (!match || typeof match !== "object") return undefined;
  const label = (match as { label?: unknown }).label;
  return typeof label === "string" && label.trim().length > 0
    ? label.trim()
    : undefined;
}

function compactModelLabel(model: string): string {
  const tail = model.split("/").filter(Boolean).at(-1) ?? model;
  return tail || model;
}

function sessionModelId(state: Record<string, unknown>): string | undefined {
  return typeof state.model === "string" && state.model.trim().length > 0
    ? state.model
    : undefined;
}

function roleBadge(
  role: string,
  message: ChatMessage,
  state: Record<string, unknown>,
): string {
  if (role === "user") return "YOU";
  if (role === "agent") {
    const model = message.model ?? sessionModelId(state);
    return (
      sidebarModelLabel(state, model) ??
      (model ? compactModelLabel(model) : "AI")
    );
  }
  return "SYS";
}

function sidebarModelsRef(state: Record<string, unknown>): unknown {
  const sidebar = state.sidebar;
  return sidebar && typeof sidebar === "object"
    ? (sidebar as { models?: unknown }).models
    : undefined;
}

function deliveryLabel(delivery: ChatMessage["delivery"]): string | null {
  switch (delivery) {
    case "queued":
      return "queued";
    case "steered":
      return "steered";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function ThinkingBlock({
  children,
  complete = true,
}: {
  children: string;
  complete?: boolean;
}) {
  const label = complete ? "Thinking" : "Thinking...";
  return (
    <div className="a2ui-thinking-block">
      <div className="a2ui-thinking-label">{label}</div>
      <div className="a2ui-thinking-content a2ui-markdown">
        <ReactMarkdown {...CHAT_MARKDOWN_PROPS}>{children}</ReactMarkdown>
      </div>
    </div>
  );
}

function hasFencedCodeMarker(text: string | undefined): boolean {
  return FENCED_CODE_MARKER_RE.test(text ?? "");
}

function MarkdownWithThinking({
  text,
  streamingFences = false,
  thinkingVisibility = "show",
}: {
  text: string;
  streamingFences?: boolean;
  thinkingVisibility?: VisibilityMode;
}) {
  const markdownProps = streamingFences
    ? CHAT_STREAMING_MARKDOWN_PROPS
    : CHAT_MARKDOWN_PROPS;
  return (
    <>
      {splitThinkingBlocks(text).map((segment, index) => {
        if (!segment.content) return null;
        if (segment.type === "thinking") {
          if (thinkingVisibility !== "show") return null;
          return (
            <ThinkingBlock key={index} complete={segment.closed !== false}>
              {segment.content}
            </ThinkingBlock>
          );
        }
        return (
          <ReactMarkdown key={index} {...markdownProps}>
            {segment.content}
          </ReactMarkdown>
        );
      })}
    </>
  );
}

const MemoMarkdownWithThinking = memo(MarkdownWithThinking);

function AttachmentGallery({ attachments }: { attachments: ChatAttachment[] }) {
  const [open, setOpen] = useState<ChatAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="a2ui-message-attachments">
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            className="a2ui-message-attachment"
            onClick={() => setOpen(attachment)}
            aria-label={`Open ${attachment.name}`}
          >
            <ImageAttachmentImage attachment={attachment} alt="" />
            <span>{attachment.name}</span>
          </button>
        ))}
      </div>
      {open && (
        <ImageLightbox attachment={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

export const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    state,
    tabId,
    className = "a2ui-chat-message",
    prevRole,
    onEvent,
    deliveryText,
    isLatest,
    thinkingVisibility = "show",
  }: {
    message: ChatMessage;
    state: Record<string, unknown>;
    tabId?: string;
    className?: string;
    prevRole?: string;
    onEvent?: BuiltinComponentProps["onEvent"];
    deliveryText?: string;
    isLatest?: boolean;
    thinkingVisibility?: VisibilityMode;
  }) {
    const [confirmingRollback, setConfirmingRollback] = useState(false);
    const displayMessage = normalizeAgentMessageForDisplay(message);
    // Rollback / fork are offered on real user/assistant turns that carry a pi
    // entry id (tool-card and system rows are not branch targets). Thinking-only
    // turns count too — they're valid branch points.
    const canBranch =
      Boolean(message.entryId) &&
      (message.role === "user" || message.role === "agent") &&
      (Boolean(displayMessage.text) || Boolean(displayMessage.thinking)) &&
      Boolean(onEvent);
    const isCanvas = className === "a2ui-canvas-message";
    const roleClass = isCanvas ? "a2ui-canvas-role" : "a2ui-chat-role";
    const textClass = isCanvas
      ? "a2ui-canvas-text a2ui-markdown"
      : "a2ui-chat-text a2ui-markdown";
    const showRole = prevRole !== message.role;
    const delivery =
      message.role === "user"
        ? (deliveryText ?? deliveryLabel(message.delivery))
        : null;
    const streamingFences =
      isLatest &&
      message.role === "agent" &&
      state.waiting === true &&
      hasFencedCodeMarker(displayMessage.text);
    return (
      <div
        className={`${className} ${message.role}${showRole ? "" : " ae-msg-cont"}`}
      >
        {message.role !== "system" && (showRole || delivery) && (
          <span className="a2ui-chat-meta">
            {showRole && (
              <span className={roleClass}>
                {roleBadge(message.role, message, state)}
              </span>
            )}
            {delivery && (
              <span
                className={`a2ui-chat-delivery a2ui-chat-delivery-${delivery}`}
              >
                {delivery}
              </span>
            )}
            {delivery === "failed" && message.text && onEvent && (
              <button
                type="button"
                className="a2ui-chat-retry"
                onClick={() =>
                  onEvent("retry", {
                    messageId: message.id,
                    value: message.text,
                  })
                }
              >
                Retry
              </button>
            )}
          </span>
        )}
        {displayMessage.thinking && thinkingVisibility === "show" && (
          <ThinkingBlock complete={Boolean(displayMessage.text)}>
            {displayMessage.thinking}
          </ThinkingBlock>
        )}
        {displayMessage.text && (
          <div className={textClass}>
            <MemoMarkdownWithThinking
              text={displayMessage.text}
              streamingFences={streamingFences}
              thinkingVisibility={thinkingVisibility}
            />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentGallery attachments={message.attachments} />
        )}
        {message.a2ui && (
          <A2UIRenderer
            payload={message.a2ui}
            state={state}
            onEvent={forwardNestedA2UIEvent(onEvent)}
            tabId={tabId}
          />
        )}
        {canBranch && (
          <div
            className="ae-msg-branch-actions"
            onMouseLeave={() => setConfirmingRollback(false)}
          >
            {confirmingRollback ? (
              <>
                <button
                  type="button"
                  className="ae-msg-branch-btn ae-msg-branch-confirm"
                  onClick={() => {
                    setConfirmingRollback(false);
                    onEvent?.("rollback-to-here", { entryId: message.entryId });
                  }}
                >
                  Confirm rollback
                </button>
                <button
                  type="button"
                  className="ae-msg-branch-btn"
                  onClick={() => setConfirmingRollback(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ae-msg-branch-btn ae-msg-branch-icon-btn"
                  aria-label="Rollback to this message"
                  title="Rewind the conversation to this message"
                  onClick={() => setConfirmingRollback(true)}
                >
                  <span aria-hidden="true">↶</span>
                </button>
                <button
                  type="button"
                  className="ae-msg-branch-btn ae-msg-branch-icon-btn"
                  aria-label="Fork from this message"
                  title="Fork the conversation into a new tab from here"
                  onClick={() =>
                    onEvent?.("fork-to-tab", { entryId: message.entryId })
                  }
                >
                  <span aria-hidden="true">⑂</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.tabId === next.tabId &&
    prev.className === next.className &&
    prev.prevRole === next.prevRole &&
    prev.onEvent === next.onEvent &&
    prev.deliveryText === next.deliveryText &&
    prev.thinkingVisibility === next.thinkingVisibility &&
    (!next.message.text ||
      !next.isLatest ||
      prev.state.waiting === next.state.waiting) &&
    (!next.message.text || prev.isLatest === next.isLatest) &&
    (next.message.role !== "agent" ||
      (prev.state.model === next.state.model &&
        sidebarModelsRef(prev.state) === sidebarModelsRef(next.state))) &&
    (!next.message.a2ui ||
      shallowEqualExcept(prev.state, next.state, VOLATILE_ROW_STATE_KEYS)),
);
