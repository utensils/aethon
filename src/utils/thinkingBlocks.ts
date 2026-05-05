export interface ThinkingBlockSegment {
  type: "text" | "thinking";
  content: string;
  closed?: boolean;
}

const THINKING_TAG_RE = /<\/?(?:think|thinking)>/gi;

function isOpeningTag(tag: string): boolean {
  return !tag.startsWith("</");
}

export function splitThinkingBlocks(text: string): ThinkingBlockSegment[] {
  const segments: ThinkingBlockSegment[] = [];
  let index = 0;
  let match: RegExpExecArray | null;

  THINKING_TAG_RE.lastIndex = 0;
  while ((match = THINKING_TAG_RE.exec(text))) {
    const tag = match[0];
    if (!isOpeningTag(tag)) continue;

    if (match.index > index) {
      segments.push({ type: "text", content: text.slice(index, match.index) });
    }

    const contentStart = THINKING_TAG_RE.lastIndex;
    let close: RegExpExecArray | null;
    for (;;) {
      close = THINKING_TAG_RE.exec(text);
      if (!close || !isOpeningTag(close[0])) break;
    }

    if (close && !isOpeningTag(close[0])) {
      segments.push({
        type: "thinking",
        content: text.slice(contentStart, close.index),
        closed: true,
      });
      index = THINKING_TAG_RE.lastIndex;
    } else {
      segments.push({
        type: "thinking",
        content: text.slice(contentStart),
        closed: false,
      });
      index = text.length;
      break;
    }
  }

  if (index < text.length) {
    segments.push({ type: "text", content: text.slice(index) });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}
