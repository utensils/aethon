import type { RefObject } from "react";
import type { AtMention, AtMentionMatch } from "./at-mention";
import { formatAtMentionInsertion } from "./at-mention";

export interface VoiceSurfaceBlockState {
  surfaceActive: boolean;
  settingsOpen?: boolean;
  paletteOpen?: boolean;
  searchOpen?: boolean;
  disabled?: boolean;
}

export function isVoiceSurfaceBlocked({
  surfaceActive,
  settingsOpen,
  paletteOpen,
  searchOpen,
  disabled,
}: VoiceSurfaceBlockState): boolean {
  return (
    !!disabled ||
    !surfaceActive ||
    !!settingsOpen ||
    !!paletteOpen ||
    !!searchOpen
  );
}

export function shouldSubmitAtMentionEnter({
  atMatch,
  highlightedMatch,
}: {
  atMatch: AtMention;
  highlightedMatch: AtMentionMatch | undefined;
}): boolean {
  if (highlightedMatch?.kind === "agent") return false;
  return atMatch.matches.some(
    (match) => match.kind === "file" && match.rel === atMatch.query,
  );
}

export function insertMentionAtCursor({
  value,
  atMatch,
  match,
}: {
  value: string;
  atMatch: AtMention;
  match: AtMentionMatch;
}): { text: string; cursor: number } {
  const insertion = formatAtMentionInsertion(match);
  const text = value.slice(0, atMatch.start) + insertion + value.slice(atMatch.end);
  return { text, cursor: atMatch.start + insertion.length };
}

export function restoreTextareaCursor(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  cursor: number,
): void {
  requestAnimationFrame(() => {
    const current = textareaRef.current;
    if (!current) return;
    current.focus();
    current.selectionStart = current.selectionEnd = cursor;
  });
}
