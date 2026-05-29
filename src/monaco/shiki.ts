/**
 * Wire Shiki grammars + themes into Monaco's tokenisation pipeline.
 *
 * Monaco ships its own tokenizers but only for a handful of web stack
 * languages (JS/TS/CSS/HTML/JSON). Anything else — Rust, Python, Go,
 * Nix, Ruby, TOML, Terraform, … — renders as plaintext until we give
 * Monaco a grammar. `@shikijs/monaco` lets us reuse the same Shiki
 * grammars Aethon already loads for chat code blocks: one canonical set,
 * proven palette, accurate tokenisation.
 *
 * Two-step contract — both steps matter:
 *
 *  1. `registerEditorLanguages()` (synchronous, eager) registers every
 *     Monaco language id `languageFromPath` can return. `@shikijs/monaco`
 *     only installs a token provider for languages Monaco *already knows
 *     about*; `monaco-editor`'s bundled `basic-languages` registers many
 *     ids (ruby, rust, go…) but NOT `toml` or `nix`, so without this step
 *     those silently fall back to plaintext. Registering eagerly (before
 *     any model is created) also means a tab opened before the async
 *     grammar load resolves still has a known language id, so it
 *     re-tokenises in place the moment the grammars bind.
 *
 *  2. `ensureShikiMonacoReady()` (async, lazy) creates the highlighter
 *     and binds its grammars + themes via `shikiToMonaco`. Call it once
 *     before mounting the first editor; the promise caches so subsequent
 *     calls are no-ops.
 *
 * The Shiki highlighter lives on the main thread here (separate from the
 * chat worker's instance) because Monaco needs *synchronous*
 * tokenisation when redrawing lines.
 *
 * Languages mirror the chat worker's `LANG_LOADERS` set in
 * `src/workers/highlight.worker.ts` so a code block's colour palette
 * matches its editor counterpart. Adding a language: add an extension
 * row in `language-detection.ts` (the source of truth for ids), a
 * grammar loader in the worker, and — if the Shiki grammar name differs
 * from the Monaco id — a `GRAMMAR_OVERRIDES` entry below.
 */

import * as monaco from "monaco-editor";
import { createHighlighter, type Highlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";

import { AETHON_SHIKI_THEMES } from "./aethon-themes";
import { EDITOR_LANGUAGE_IDS } from "./language-detection";

/** Monaco ids whose backing Shiki grammar is published under a different
 *  bundle name. `shell` → `shellscript` (Shiki's canonical id, which
 *  carries `shell`/`sh`/`bash`/`zsh` aliases so the binding still lands
 *  on our `shell` id). */
const GRAMMAR_OVERRIDES: Record<string, string> = {
  shell: "shellscript",
};

/** Shiki grammar names to load — derived from the editor's language id
 *  set so the two never drift. */
const LANGS = Array.from(
  new Set(EDITOR_LANGUAGE_IDS.map((id) => GRAMMAR_OVERRIDES[id] ?? id)),
);

let registered = false;

/**
 * Register every editor language id with Monaco. Synchronous and cheap
 * (no grammar load) so it can run at startup before the first model is
 * created. Idempotent — guarded so repeated calls (module reload, tests)
 * don't double-register.
 */
export function registerEditorLanguages(): void {
  if (registered) return;
  registered = true;
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const id of EDITOR_LANGUAGE_IDS) {
    if (!known.has(id)) {
      monaco.languages.register({ id });
      known.add(id);
    }
  }
}

let readyPromise: Promise<Highlighter> | null = null;

/**
 * Lazy-create a main-thread Shiki highlighter and bind its grammars +
 * themes to Monaco. Idempotent: subsequent calls return the cached
 * highlighter without re-binding.
 *
 * Ensures languages are registered first (so the providers actually
 * attach), then loads the grammars and binds them. After this resolves,
 * `monaco.editor.setTheme("aethon-paper")` and language="nix"/"toml"
 * both tokenize correctly, and any models already open re-tokenise.
 */
export function ensureShikiMonacoReady(): Promise<Highlighter> {
  if (readyPromise) return readyPromise;
  registerEditorLanguages();
  readyPromise = createHighlighter({
    themes: [...AETHON_SHIKI_THEMES],
    langs: [...LANGS],
  }).then((hl) => {
    shikiToMonaco(hl, monaco);
    return hl;
  });
  return readyPromise;
}

/** Test-only reset hook. Exposed so vitest can wipe the memoised
 *  promise + registration flag between cases. */
export const __testing = {
  reset(): void {
    readyPromise = null;
    registered = false;
  },
};
