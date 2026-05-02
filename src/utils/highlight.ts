/**
 * Main-thread façade for syntax highlighting via the Shiki worker.
 *
 * Mirrors the pattern in ../../Claudette/src/ui/src/utils/highlight.ts:
 * - First call lazily spawns the worker; subsequent calls reuse it.
 * - Results are cached by `${lang}\0${code}` (after stripping trailing
 *   newlines, which markdown's closing fence introduces and which would
 *   otherwise produce a phantom selection line).
 * - Cache is an insertion-ordered LRU capped at CACHE_LIMIT entries.
 * - If the worker faults, all pending promises resolve with `null` and the
 *   worker is terminated. The next call rebuilds it.
 */

import HighlightWorker from "../workers/highlight.worker?worker";

const CACHE_LIMIT = 500;

const cache = new Map<string, string>();
const pending = new Map<number, (html: string | null) => void>();

let worker: Worker | null = null;
let nextId = 0;

function cacheKey(lang: string, code: string): string {
  return `${lang}\0${code}`;
}

function trimTrailingNewline(code: string): string {
  let end = code.length;
  while (end > 0 && code.charCodeAt(end - 1) === 0x0a) end--;
  return end === code.length ? code : code.slice(0, end);
}

function bumpLru(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function failAllPending(): void {
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new HighlightWorker();
  w.addEventListener(
    "message",
    (e: MessageEvent<{ id: number; html: string | null }>) => {
      const { id, html } = e.data;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(html);
    },
  );
  w.addEventListener("error", () => {
    failAllPending();
    w.terminate();
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

/**
 * Synchronous cache lookup. Returns the highlighted inner-HTML or null
 * if the (lang, code) pair has not been highlighted before. Callers
 * pair this with [[highlightCode]] in a useEffect: render the cached
 * value immediately if present, else dispatch and force-update on
 * resolve.
 */
export function getCachedHighlight(code: string, lang: string): string | null {
  const trimmed = trimTrailingNewline(code);
  const key = cacheKey(lang, trimmed);
  const cached = cache.get(key);
  if (cached !== undefined) {
    bumpLru(key, cached);
    return cached;
  }
  return null;
}

/**
 * Async highlight via the worker. Returns the inner-HTML of Shiki's
 * `<code>` element (no `<pre>`) when successful, or null when:
 *   - the language is unknown (worker falls back to "text" — still ok)
 *   - the worker faulted
 *   - structural validation rejected the output
 *
 * On null, callers should fall back to plain `<code>{text}</code>`.
 */
export function highlightCode(
  code: string,
  lang: string,
): Promise<string | null> {
  const trimmed = trimTrailingNewline(code);
  const key = cacheKey(lang, trimmed);
  const cached = cache.get(key);
  if (cached !== undefined) {
    bumpLru(key, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (html) => {
      if (html != null) bumpLru(key, html);
      resolve(html);
    });
    getWorker().postMessage({ id, code: trimmed, lang });
  });
}

/**
 * Spawn the worker and kick off Shiki + Oniguruma WASM + theme registration
 * eagerly so the first user-visible code block doesn't pay the cold-start
 * cost. Idempotent — subsequent calls are no-ops once the worker exists.
 * Called from the app entry (main.tsx) so warm-up overlaps with the rest
 * of app boot rather than blocking the first render of a workspace.
 */
export function prewarmHighlighter(): void {
  if (worker) return;
  void highlightCode("", "text");
}

// Reset module state when Vite hot-reloads this file in dev so we don't leak
// the previous Worker instance across HMR boundaries.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    failAllPending();
    worker?.terminate();
    worker = null;
    cache.clear();
  });
}

// Test-only hooks: expose the cache + a reset so unit tests can inspect /
// clear state without touching the worker (which is stubbed in tests).
export const __testing = {
  cache,
  pending,
  reset(): void {
    failAllPending();
    cache.clear();
    worker?.terminate();
    worker = null;
    nextId = 0;
  },
};
