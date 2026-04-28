import { Highlight } from "prism-react-renderer";
import { aethonPrismTheme } from "./prismTheme";

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

// prism-react-renderer ships a small set of grammars by default. Map common
// aliases to the loaded language names; unknown values fall back to `text`
// so highlighting becomes a no-op rather than crashing.
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  console: "bash",
};

function normalizeLanguage(lang?: string): string {
  if (!lang) return "text";
  const v = lang.toLowerCase();
  return LANGUAGE_ALIASES[v] ?? v;
}

export function HighlightedCode({
  code,
  language,
  showLineNumbers,
  inline,
  className,
}: HighlightedCodeProps) {
  const lang = normalizeLanguage(language);
  const text = trimSingleTrailingNewline(code);

  if (inline) {
    return (
      <Highlight code={text} language={lang} theme={aethonPrismTheme}>
        {({ tokens, getTokenProps }) => (
          <code className={`a2ui-code-inline ${className ?? ""}`}>
            {tokens.map((line, i) => (
              <span key={i}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </span>
            ))}
          </code>
        )}
      </Highlight>
    );
  }

  return (
    <Highlight code={text} language={lang} theme={aethonPrismTheme}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`a2ui-code ${className ?? ""}`}
          data-language={language ?? lang}
        >
          {language && <span className="a2ui-code-lang">{language}</span>}
          <code>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div key={i} {...lineProps} className="a2ui-code-line">
                  {showLineNumbers && (
                    <span className="a2ui-code-lineno">{i + 1}</span>
                  )}
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </div>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
