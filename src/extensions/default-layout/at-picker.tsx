import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { FileIcon } from "../../components/file-icon";
import type { AtFileMatch, AtMention } from "./at-mention";
import { usePickerAnchor } from "./use-picker-anchor";

interface AtPickerProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  atMatch: AtMention | null;
  highlightIdx: number;
  setHighlightIdx: Dispatch<SetStateAction<number>>;
  onInsert: (match: AtFileMatch) => void;
}

/**
 * `@file` completion menu. Shares the slash picker's chrome (portal +
 * fixed anchor + `.a2ui-slash-menu` styling) so the two composer
 * popovers look and behave identically; rows render basename-first with
 * the directory dimmed, like quick-open.
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
      aria-label="File suggestions"
      style={{
        position: "fixed",
        left: `${menuAnchor.left}px`,
        bottom: `${menuAnchor.bottom}px`,
        width: `${menuAnchor.width}px`,
      }}
    >
      {atMatch.matches.map((m, i) => {
        const slash = m.rel.lastIndexOf("/");
        const base = slash >= 0 ? m.rel.slice(slash + 1) : m.rel;
        const dir = slash >= 0 ? m.rel.slice(0, slash) : "";
        return (
          <div
            key={m.rel}
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
            <FileIcon path={m.rel} isDir={false} size={14} />
            <span className="a2ui-at-item-name">{base}</span>
            {dir && <span className="a2ui-at-item-dir">{dir}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
