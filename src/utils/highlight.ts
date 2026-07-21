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

/**
 * Spawn via the standard `new Worker(new URL(...))` pattern (Vite bundles
 * the worker chunk for it, same as the old `?worker` default-import) so
 * plain esbuild consumers — e.g. the /design-sync bundle that ships the
 * `code` primitive to claude.ai/design — can compile this module. Where
 * workers can't spawn (no bundler URL, jsdom), the throw is caught in
 * `getWorker` and every highlight resolves null → plain-text fallback.
 */
function createHighlightWorker(): Worker {
  return new Worker(new URL("../workers/highlight.worker.ts", import.meta.url), {
    type: "module",
  });
}

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

function getWorker(): Worker | null {
  if (worker) return worker;
  let w: Worker;
  try {
    w = createHighlightWorker();
  } catch {
    // No worker support in this host (static bundle, jsdom) — callers
    // resolve null and render the plain-text fallback.
    return null;
  }
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
    const w = getWorker();
    if (!w) {
      pending.delete(id);
      resolve(null);
      return;
    }
    w.postMessage({ id, code: trimmed, lang });
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

/**
 * Register an extension-contributed TextMate grammar with the highlight
 * worker. Fire-and-forget; the worker's `register-grammar` handler awaits
 * its own `loadLanguage` so a follow-up `highlightCode(_, lang)` sees it
 * loaded. Idempotent — re-registering the same `lang` overwrites.
 *
 * This is the extension surface for `code` primitive. The primitive
 * itself can't be overridden (it's in `PRIMITIVE_REGISTRY`, by design),
 * but extensions that need to highlight a language Aethon doesn't ship
 * (e.g. Lean, Coq, an in-house DSL) can register a TextMate grammar
 * here and the existing `code` primitive will use it.
 *
 * For extensions that want a different highlighting *engine* entirely
 * (highlight.js, codemirror, …), the documented escape hatch is to
 * register a custom component type via `aethon.registerComponent` and
 * route layouts at it instead of `code` — see
 * `docs/aethon-agent/extensions.md`.
 */
export function registerGrammar(lang: string, grammar: unknown): void {
  // Drop any cache entry keyed by this lang. A common scenario:
  //   1. User loads a workspace; chat renders code ```mylang``` as plain
  //      text because the grammar isn't loaded yet → cached as plain.
  //   2. An extension calls `registerGrammar("mylang", …)` later in boot.
  //   3. Without this eviction, the same `(lang, code)` pair would keep
  //      hitting the stale plain-text entry and the user would never see
  //      the new grammar take effect on already-rendered blocks.
  // Iteration is fine — the cache caps at 500 entries and registrations
  // are rare (extension boot, not per-render).
  const prefix = `${lang}\0`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  getWorker()?.postMessage({ type: "register-grammar", lang, grammar });
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
