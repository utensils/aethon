/**
 * Wire Shiki grammars + themes into Monaco's tokenisation pipeline.
 *
 * Monaco ships its own tokenizers but only for a handful of web stack
 * languages (JS/TS/CSS/HTML/JSON). Anything else — Rust, Python, Go,
 * Nix, Ruby, Java, Shell, YAML, TOML, … — renders as plaintext until we
 * give Monaco a grammar. `@shikijs/monaco` lets us reuse the same Shiki
 * grammars Aethon already loads for chat code blocks: one canonical set,
 * proven palette, accurate tokenisation.
 *
 * The Shiki highlighter lives on the main thread here (separate from the
 * chat worker's instance) because Monaco needs *synchronous*
 * tokenisation when redrawing lines. Setup is async and lazy — call
 * `ensureShikiMonacoReady()` once before mounting the first editor; the
 * promise caches so subsequent calls are no-ops.
 *
 * Languages loaded match the chat worker's `LANG_LOADERS` set in
 * `src/workers/highlight.worker.ts` so a code block's colour palette
 * matches its editor counterpart. Adding a language: add it to both
 * `LANG_LOADERS` (worker) and `LANGS` (this file) so the two stay in
 * sync.
 */

import * as monaco from "monaco-editor";
import { createHighlighter, type Highlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";

/** Languages Aethon ships syntax highlighting for. Mirrors the
 *  `LANG_LOADERS` set in `src/workers/highlight.worker.ts`. */
const LANGS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "graphql",
  "haskell",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "lua",
  "make",
  "markdown",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "shellscript",
  "sql",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "xml",
  "yaml",
  "zig",
] as const;

const THEMES = ["github-dark", "github-light"] as const;

let readyPromise: Promise<Highlighter> | null = null;

/**
 * Lazy-create a main-thread Shiki highlighter and bind its grammars +
 * themes to Monaco. Idempotent: subsequent calls return the cached
 * highlighter without re-binding.
 *
 * Returns the highlighter so callers can fire one-off `codeToHast`
 * queries if needed. The primary side-effect is registering ~35
 * Monaco languages + 2 Monaco themes; after this resolves,
 * `monaco.editor.setTheme("github-dark")` and language="nix" both
 * tokenize correctly.
 */
export function ensureShikiMonacoReady(): Promise<Highlighter> {
  if (readyPromise) return readyPromise;
  readyPromise = createHighlighter({
    themes: [...THEMES],
    langs: [...LANGS],
  }).then((hl) => {
    shikiToMonaco(hl, monaco);
    return hl;
  });
  return readyPromise;
}

/** Test-only reset hook. Exposed so vitest can wipe the memoised
 *  promise between cases when it stubs the highlighter. */
export const __testing = {
  reset(): void {
    readyPromise = null;
  },
};
