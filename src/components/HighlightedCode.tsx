import { useEffect, useReducer, useRef, useState } from "react";
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

async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard availability is host/browser dependent; the block remains selectable.
    return false;
  }
}

// Worker-backed Shiki highlighter (same pattern as Claudette's chat).
// Renders dual-theme HTML: each token span carries `--shiki-light` +
// `--shiki-dark` inline, and src/styles/chrome.css picks via `light-dark()` based
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
  const displayLang = lang || "text";
  const cached = lang ? getCachedHighlight(text, lang) : null;
  const copyResetTimer = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
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

  useEffect(() => {
    return () => {
      if (copyResetTimer.current != null) {
        window.clearTimeout(copyResetTimer.current);
      }
    };
  }, []);

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

  const codeEl =
    cached != null ? (
      <code dangerouslySetInnerHTML={{ __html: cached }} />
    ) : (
      <code>{text}</code>
    );

  if (lang === "text" && !showLineNumbers) {
    return (
      <pre className={`a2ui-code ${className ?? ""}`} data-language="text">
        {codeEl}
      </pre>
    );
  }

  return (
    <div
      className={`a2ui-code-frame ${className ?? ""}`}
      data-language={lang || "plain"}
    >
      <div className="a2ui-code-header">
        <span className="a2ui-code-title">{displayLang}</span>
        <button
          type="button"
          className="a2ui-code-copy"
          data-copied={copied ? "true" : undefined}
          aria-label={copied ? "Copied code" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void copyText(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              if (copyResetTimer.current != null) {
                window.clearTimeout(copyResetTimer.current);
              }
              copyResetTimer.current = window.setTimeout(() => {
                setCopied(false);
                copyResetTimer.current = null;
              }, 1200);
            });
          }}
        />
      </div>
      <pre
        className="a2ui-code"
        data-language={lang || "plain"}
        data-show-lineno={showLineNumbers ? "true" : undefined}
      >
        {codeEl}
      </pre>
    </div>
  );
}
