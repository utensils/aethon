import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { FileIcon } from "../../components/file-icon";
import type { AtMention, AtMentionMatch } from "./at-mention";
import { usePickerAnchor } from "./use-picker-anchor";

interface AtPickerProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  atMatch: AtMention | null;
  highlightIdx: number;
  setHighlightIdx: Dispatch<SetStateAction<number>>;
  onInsert: (match: AtMentionMatch) => void;
}

/**
 * `@` completion menu. Shares the slash picker's chrome (portal +
 * fixed anchor + `.a2ui-slash-menu` styling) so the two composer
 * popovers look and behave identically. File rows render basename-first
 * like quick-open; agent rows render as lightweight delegates.
 */
export function AtPicker({
  anchorRef,
  atMatch,
  highlightIdx,
  setHighlightIdx,
  onInsert,
}: AtPickerProps) {
  const menuAnchor = usePickerAnchor(anchorRef, atMatch);

  if (!atMatch || !menuAnchor) return null;

  return createPortal(
    <div
      className="a2ui-slash-menu"
      role="listbox"
      aria-label="Mention suggestions"
      style={{
        position: "fixed",
        left: `${menuAnchor.left}px`,
        bottom: `${menuAnchor.bottom}px`,
        width: `${menuAnchor.width}px`,
      }}
    >
      {atMatch.matches.map((m, i) => {
        const key = m.kind === "agent" ? `agent:${m.name}` : `file:${m.rel}`;
        return (
          <div
            key={key}
            role="option"
            aria-selected={i === highlightIdx}
            className={
              i === highlightIdx
                ? "a2ui-slash-item a2ui-at-item a2ui-slash-item-active"
                : "a2ui-slash-item a2ui-at-item"
            }
            onMouseDown={(e) => {
              e.preventDefault();
              onInsert(m);
            }}
            onMouseEnter={() => setHighlightIdx(i)}
          >
            {m.kind === "agent" ? (
              <AgentRow match={m} />
            ) : (
              <FileRow match={m} />
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

function AgentRow({
  match,
}: {
  match: Extract<AtMentionMatch, { kind: "agent" }>;
}) {
  const meta =
    match.surface === "tab" ? "tab" : match.model ? match.model : "agent";
  return (
    <>
      <span className="a2ui-at-agent-mark" aria-hidden="true">
        @
      </span>
      <span className="a2ui-at-item-main">
        <span className="a2ui-at-item-name">@{match.name}</span>
        <span className="a2ui-at-item-desc">{match.description}</span>
      </span>
      <span className="a2ui-at-item-meta">{meta}</span>
    </>
  );
}

function FileRow({
  match,
}: {
  match: Extract<AtMentionMatch, { kind: "file" }>;
}) {
  const slash = match.rel.lastIndexOf("/");
  const base = slash >= 0 ? match.rel.slice(slash + 1) : match.rel;
  const dir = slash >= 0 ? match.rel.slice(0, slash) : "";
  return (
    <>
      <FileIcon path={match.rel} isDir={false} size={14} />
      <span className="a2ui-at-item-name">{base}</span>
      {dir && <span className="a2ui-at-item-dir">{dir}</span>}
    </>
  );
}
