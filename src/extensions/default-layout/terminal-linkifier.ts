import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  IBufferRange,
  ILinkProvider,
  IDisposable,
  ILink,
} from "@xterm/xterm";

const TERMINAL_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const TRAILING_CLOSERS: Partial<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

export interface TerminalUrlLink {
  text: string;
  startColumn: number;
  endColumn: number;
  range: IBufferRange;
}

type LinkableTerminal = {
  buffer: {
    active: {
      getLine(y: number):
        | {
            translateToString(
              trimRight?: boolean,
              startColumn?: number,
              endColumn?: number,
            ): string;
          }
        | undefined;
    };
  };
  registerLinkProvider(linkProvider: ILinkProvider): IDisposable;
};

export function findTerminalUrlLinks(
  lineText: string,
  bufferLineNumber: number,
): TerminalUrlLink[] {
  const links: TerminalUrlLink[] = [];
  for (const match of lineText.matchAll(TERMINAL_URL_PATTERN)) {
    const rawText = match[0] ?? "";
    const text = trimTerminalUrl(rawText);
    if (!text) continue;
    const matchIndex = match.index ?? 0;
    const startColumn = matchIndex + 1;
    const endColumn = matchIndex + text.length;
    links.push({
      text,
      startColumn,
      endColumn,
      range: {
        start: { x: startColumn, y: bufferLineNumber },
        end: { x: endColumn, y: bufferLineNumber },
      },
    });
  }
  return links;
}

export function registerTerminalUrlLinks(term: LinkableTerminal): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const links = findTerminalUrlLinks(
        line.translateToString(true),
        bufferLineNumber,
      ).map(toXtermLink);
      callback(links.length > 0 ? links : undefined);
    },
  });
}

function toXtermLink(link: TerminalUrlLink): ILink {
  return {
    range: link.range,
    text: link.text,
    decorations: {
      pointerCursor: true,
      underline: true,
    },
    activate(event, text) {
      event.preventDefault();
      void openUrl(text).catch(() => undefined);
    },
  };
}

function trimTerminalUrl(rawText: string): string {
  let text = rawText;
  while (text.length > 0) {
    const last = text[text.length - 1];
    if (TRAILING_URL_PUNCTUATION.has(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const opener = TRAILING_CLOSERS[last];
    if (opener && charCount(text, last) > charCount(text, opener)) {
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  return text;
}

function charCount(value: string, needle: string): number {
  let count = 0;
  for (const char of value) {
    if (char === needle) count += 1;
  }
  return count;
}
