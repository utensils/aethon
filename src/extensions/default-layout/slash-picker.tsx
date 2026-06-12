import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import type {
  ArgMatch,
  PickerMatch,
  SlashMatch,
} from "./use-slash-matching";
import { usePickerAnchor } from "./use-picker-anchor";

interface SlashPickerProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  slashMatch: SlashMatch | null;
  highlightIdx: number;
  setHighlightIdx: Dispatch<SetStateAction<number>>;
  onInsert: (match: PickerMatch) => void;
  onSubmitArg: (match: ArgMatch) => void;
}

export function SlashPicker({
  anchorRef,
  slashMatch,
  highlightIdx,
  setHighlightIdx,
  onInsert,
  onSubmitArg,
}: SlashPickerProps) {
  const menuAnchor = usePickerAnchor(anchorRef, slashMatch);

  if (!slashMatch || !menuAnchor) return null;

  return createPortal(
    <div
      className="a2ui-slash-menu"
      role="listbox"
      style={{
        position: "fixed",
        left: `${menuAnchor.left}px`,
        bottom: `${menuAnchor.bottom}px`,
        width: `${menuAnchor.width}px`,
      }}
    >
      {slashMatch.mode === "arg" && slashMatch.cmd && (
        <div className="a2ui-slash-arg-header">
          <span className="a2ui-slash-arg-cmd">/{slashMatch.cmd.name}</span>
          <span className="a2ui-slash-arg-hint">
            {slashMatch.cmd.description ?? "select an option"}
          </span>
        </div>
      )}
      {slashMatch.matches.map((m, i) => {
        const key =
          m.kind === "command" ? m.cmd.name : `${m.cmd.name}::${m.choice.value}`;
        return (
          <div
            key={key}
            role="option"
            aria-selected={i === highlightIdx}
            className={
              i === highlightIdx
                ? "a2ui-slash-item a2ui-slash-item-active"
                : "a2ui-slash-item"
            }
            onMouseDown={(e) => {
              e.preventDefault();
              if (m.kind === "arg") {
                onSubmitArg(m);
              } else {
                onInsert(m);
              }
            }}
            onMouseEnter={() => setHighlightIdx(i)}
          >
            {m.kind === "command" ? (
              <>
                <span className="a2ui-slash-item-name">/{m.cmd.name}</span>
                {m.cmd.usage && (
                  <span className="a2ui-slash-item-usage">
                    {" "}
                    {m.cmd.usage}
                  </span>
                )}
                {m.cmd.description && (
                  <span className="a2ui-slash-item-desc">
                    {" "}
                    — {m.cmd.description}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="a2ui-slash-item-name">{m.choice.value}</span>
                {m.choice.label && m.choice.label !== m.choice.value && (
                  <span className="a2ui-slash-item-desc">
                    {" "}
                    — {m.choice.label}
                  </span>
                )}
                {m.choice.description && (
                  <span className="a2ui-slash-item-desc">
                    {" "}
                    — {m.choice.description}
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
