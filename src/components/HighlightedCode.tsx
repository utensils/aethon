import { useEffect, useReducer } from "react";
import { getCachedHighlight, highlightCode } from "../utils/highlight";

interface HighlightedCodeProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  inline?: boolean;
  className?: string;
}

// Markdown sometimes hands us ` ```ts ` (no content) or whitespace; trim a
// single trailing newline so the output doesn't grow an empty line at the
// bottom of every block.
function trimSingleTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

// Worker-backed Shiki highlighter (same pattern as Claudette's chat).
// Renders dual-theme HTML: each token span carries `--shiki-light` +
// `--shiki-dark` inline, and src/styles.css picks via `light-dark()` based
// on the active theme's `color-scheme`. Cache hit → render highlighted
// immediately; miss → render plain text and force-update once the worker
// resolves. A null worker result (unknown language, worker fault) keeps
// the plain-text fallback.
export function HighlightedCode({
  code,
  language,
  showLineNumbers,
  inline,
  className,
}: HighlightedCodeProps) {
  const text = trimSingleTrailingNewline(code);
  const lang = (language ?? "").toLowerCase();
  const cached = lang ? getCachedHighlight(text, lang) : null;
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!lang) return;
    if (cached != null) return;
    let cancelled = false;
    void highlightCode(text, lang).then((html) => {
      if (!cancelled && html != null) forceUpdate();
    });
    return () => {
      cancelled = true;
    };
    // `text` and `lang` cover identity changes; `cached` retriggers if the
    // cache is reset between renders.
  }, [text, lang, cached]);

  if (inline) {
    if (cached != null) {
      return (
        <code
          className={`a2ui-code-inline ${className ?? ""}`}
          dangerouslySetInnerHTML={{ __html: cached }}
        />
      );
    }
    return (
      <code className={`a2ui-code-inline ${className ?? ""}`}>{text}</code>
    );
  }

  return (
    <pre
      className={`a2ui-code ${className ?? ""}`}
      data-language={language ?? lang}
      data-show-lineno={showLineNumbers ? "true" : undefined}
    >
      {language && <span className="a2ui-code-lang">{language}</span>}
      {cached != null ? (
        <code dangerouslySetInnerHTML={{ __html: cached }} />
      ) : (
        <code>{text}</code>
      )}
    </pre>
  );
}
