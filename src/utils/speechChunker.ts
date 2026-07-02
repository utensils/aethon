/** Turn a streaming text delta into clause-sized TTS chunks.
 *
 *  Feeding a TTS websocket word-by-word produces choppy prosody; waiting for
 *  the whole reply wastes the streaming latency win. Splitting on clause
 *  punctuation past a minimum length is the middle ground: the first chunk
 *  reaches the synthesizer as soon as the first sentence lands.
 */

/** Don't emit a chunk shorter than this unless flushing — very short
 *  fragments synthesize with poor rhythm. */
const MIN_CHUNK_CHARS = 40;

const CLAUSE_BOUNDARY = /[.!?;:]/;

export interface SpeechChunker {
  /** Feed a streamed delta; returns any chunks that became ready. */
  push(delta: string): string[];
  /** Return whatever is buffered (possibly empty) and reset. */
  flush(): string;
  /** Drop the buffer (barge-in / cancel). */
  reset(): void;
}

export function createSpeechChunker(): SpeechChunker {
  let buffer = "";
  return {
    push(delta: string): string[] {
      buffer += delta;
      const chunks: string[] = [];
      for (;;) {
        const boundary = findBoundary(buffer);
        if (boundary === -1) break;
        chunks.push(buffer.slice(0, boundary + 1));
        buffer = buffer.slice(boundary + 1);
      }
      return chunks;
    },
    flush(): string {
      const rest = buffer.trim();
      buffer = "";
      return rest;
    },
    reset(): void {
      buffer = "";
    },
  };
}

/** Last clause boundary at or beyond the minimum chunk size, so we emit the
 *  largest ready clause run instead of one clause at a time. */
function findBoundary(text: string): number {
  for (let index = text.length - 1; index >= MIN_CHUNK_CHARS - 1; index -= 1) {
    const char = text[index] ?? "";
    if (!CLAUSE_BOUNDARY.test(char)) continue;
    // "3.5" / "v1.2" style decimals are not clause boundaries.
    if (
      char === "." &&
      /\d/.test(text[index - 1] ?? "") &&
      /\d/.test(text[index + 1] ?? "")
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

/** Ceiling on work-agent text forwarded to the voice brain as summary source
 *  material (the bridge re-checks). */
export const SPEECH_SOURCE_CAP = 4_000;

/** Prepare work-agent prose for the brain: drop fenced code blocks (never
 *  speakable) and cap the length. */
export function stripForSpeechSource(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .slice(0, SPEECH_SOURCE_CAP);
}
