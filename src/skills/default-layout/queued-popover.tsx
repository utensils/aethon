import { memo, useEffect, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { QueuedMessage } from "../../types/tab";

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5l5 5 5-5" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  );
}

function SteerIcon() {
  return (
    <svg
      width="13"
      height="13"
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
  );
}

function DeleteIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9" />
    </svg>
  );
}

function QueuedSpinner() {
  return (
    <svg
      className="a2ui-queued-spinner"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface QueuedMessageRowProps {
  message: QueuedMessage;
  steering: boolean;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onSteer: (id: string) => void;
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  message,
  steering,
  onEdit,
  onDelete,
  onSteer,
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resync edit textarea from authoritative queue content when editing opens
      setDraft(message.content);
      const handle = requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.select();
      });
      return () => cancelAnimationFrame(handle);
    }
    return undefined;
  }, [editing, message.content]);

  function commitEdit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      onDelete(message.id);
    } else if (trimmed !== message.content) {
      onEdit(message.id, trimmed);
    }
    setEditing(false);
  }

  function cancelEdit() {
    setDraft(message.content);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  if (editing) {
    return (
      <li className="a2ui-queued-message a2ui-queued-message-editing">
        <div className="a2ui-queued-edit-form">
          <textarea
            ref={textareaRef}
            className="a2ui-queued-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            aria-label="Edit queued message"
          />
          <div className="a2ui-queued-edit-buttons">
            <button
              type="button"
              className="a2ui-queued-action a2ui-queued-edit-save"
              onClick={commitEdit}
              title="Save (Enter)"
              aria-label="Save edit"
            >
              Save
            </button>
            <button
              type="button"
              className="a2ui-queued-action a2ui-queued-edit-cancel"
              onClick={cancelEdit}
              title="Cancel (Esc)"
              aria-label="Cancel edit"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="a2ui-queued-message">
      <span className="a2ui-queued-icon" aria-hidden="true">
        <ChevronIcon />
      </span>
      <span className="a2ui-queued-content" title={message.content}>
        {message.content}
      </span>
      <div className="a2ui-queued-actions">
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-edit"
          onClick={() => setEditing(true)}
          title="Edit"
          aria-label="Edit queued message"
          disabled={steering}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-steer"
          onClick={() => onSteer(message.id)}
          title="Send now as steer"
          aria-label="Steer this message into the current turn"
          disabled={steering}
        >
          {steering ? <QueuedSpinner /> : <SteerIcon />}
          <span className="a2ui-queued-steer-label">
            {steering ? "STEER…" : "STEER"}
          </span>
        </button>
        <button
          type="button"
          className="a2ui-queued-action a2ui-queued-delete"
          onClick={() => onDelete(message.id)}
          title="Remove from queue"
          aria-label="Remove from queue"
          disabled={steering}
        >
          <DeleteIcon />
        </button>
      </div>
    </li>
  );
});

export function QueuedMessagesPopover({
  state,
  onEvent,
}: BuiltinComponentProps) {
  const items = (state.queuedMessages as QueuedMessage[] | undefined) ?? [];
  const steeringId = state.queuedSteeringId as string | undefined;
  if (items.length === 0) return null;

  const onEdit = (id: string, content: string) => {
    onEvent("queue:edit", { messageId: id, content });
  };
  const onDelete = (id: string) => {
    onEvent("queue:delete", { messageId: id });
  };
  const onSteer = (id: string) => {
    onEvent("queue:steer", { messageId: id });
  };
  const onClear = () => {
    onEvent("queue:clear");
  };

  return (
    <div
      className="a2ui-queued-popover"
      role="region"
      aria-label="Queued messages"
    >
      <div className="a2ui-queued-header">
        <span className="a2ui-queued-label">Queued · {items.length}</span>
        <button
          type="button"
          className="a2ui-queued-clear"
          onClick={onClear}
          aria-label="Clear queue"
          title="Drop every queued message"
        >
          Clear queue
        </button>
      </div>
      <ul className="a2ui-queued-list">
        {items.map((m) => (
          <QueuedMessageRow
            key={m.id}
            message={m}
            steering={steeringId === m.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onSteer={onSteer}
          />
        ))}
      </ul>
    </div>
  );
}
