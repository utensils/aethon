/**
 * react-markdown adapter components for the default-layout skill.
 *
 * react-markdown invokes `code` for both inline AND fenced code blocks. We
 * split on whether the parent is `<pre>` (fenced) and route the fenced case
 * through Prism + the palette-driven theme. Inline code stays as a styled
 * `<code>` so we don't tokenize prose like `someFunc()`.
 *
 * react-markdown wraps fenced blocks in `<pre><code>...</code></pre>`, so we
 * ALSO override `pre`: when its only child is the highlighted-code adapter
 * (a fenced block we produced), we render the child directly so the output
 * isn't `<pre><pre>...</pre></pre>` (invalid + double-padded).
 */

import { HighlightedCode } from "../../components/HighlightedCode";

// eslint-disable-next-line react-refresh/only-export-components -- helper consumed by the markdown-adapter map below
export function isHighlightedFenceChild(node: React.ReactNode): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as React.ReactElement<{ "data-highlighted-fence"?: boolean }>;
  return el.props?.["data-highlighted-fence"] === true;
}

// eslint-disable-next-line react-refresh/only-export-components -- adapter map for react-markdown; not a component module
export const MARKDOWN_COMPONENTS = {
  pre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
    if (isHighlightedFenceChild(children)) {
      return <>{children}</>;
    }
    return <pre {...rest}>{children}</pre>;
  },
  code({
    inline,
    className,
    children,
    node,
    ...rest
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
    node?: { tagName?: string };
  } & React.HTMLAttributes<HTMLElement>) {
    void node;
    const text = String(children ?? "").replace(/\n$/, "");
    const langMatch = /language-([\w+-]+)/.exec(className ?? "");
    if (inline || !langMatch) {
      return <code className={className} {...rest}>{children}</code>;
    }
    return (
      <HighlightedFence code={text} language={langMatch[1]} />
    );
  },
};

// Wrapper that tags the rendered element with a data attribute so the
// `pre` override above can detect "this is our fenced output" and
// unwrap the outer markdown `<pre>`.
export function HighlightedFence({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  return (
    <span data-highlighted-fence style={{ display: "block" }}>
      <HighlightedCode code={code} language={language} />
    </span>
  );
}
