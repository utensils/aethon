import { useCallback, useState, type KeyboardEvent, type RefObject } from "react";
import type { AtMentionMatch } from "./at-mention";
import { useAtMention } from "./use-at-mention";
import {
  insertMentionAtCursor,
  restoreTextareaCursor,
  shouldSubmitAtMentionEnter,
} from "./textarea-input-semantics";

export function useAtMentionTextarea({
  value,
  setValue,
  onValueCommit,
  textareaRef,
  root,
  hostId,
  enabled,
}: {
  value: string;
  setValue: (value: string) => void;
  onValueCommit?: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  root: string | null;
  hostId?: string | null;
  enabled: boolean;
}) {
  const [cursor, setCursor] = useState(0);
  const {
    atMatch,
    highlightIdx,
    setHighlightIdx,
    dismissPicker,
  } = useAtMention({ value, cursor, root, hostId, enabled });

  const insertAtMention = useCallback(
    (match: AtMentionMatch) => {
      if (!atMatch) return;
      const next = insertMentionAtCursor({ value, atMatch, match });
      setValue(next.text);
      onValueCommit?.(next.text);
      setCursor(next.cursor);
      restoreTextareaCursor(textareaRef, next.cursor);
    },
    [atMatch, onValueCommit, setValue, textareaRef, value],
  );

  const handleAtMentionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!atMatch) return false;
      const list = atMatch.matches;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const match = list[highlightIdx] ?? list[0];
        if (match) insertAtMention(match);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const match = list[highlightIdx] ?? list[0];
        if (!shouldSubmitAtMentionEnter({ atMatch, highlightedMatch: match })) {
          event.preventDefault();
          if (match) insertAtMention(match);
          return true;
        }
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissPicker();
        return true;
      }
      return false;
    },
    [atMatch, dismissPicker, highlightIdx, insertAtMention, setHighlightIdx],
  );

  return {
    atMatch,
    atHighlightIdx: highlightIdx,
    setAtHighlightIdx: setHighlightIdx,
    cursor,
    setCursor,
    insertAtMention,
    dismissAtPicker: dismissPicker,
    handleAtMentionKeyDown,
  };
}
