/**
 * react-markdown adapter components for the default-layout extension.
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

import { openUrl } from "@tauri-apps/plugin-opener";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as RehypeSanitizeOptions,
} from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { HighlightedCode } from "../../components/HighlightedCode";

type MarkdownRemarkPlugins = NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const BARE_HTTP_URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ":", ";"]);
const CLOSING_BRACKETS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function countChar(value: string, char: string): number {
  return [...value].filter((candidate) => candidate === char).length;
}

function splitTrailingUrlPunctuation(value: string): {
  url: string;
  trailing: string;
} {
  let url = value;
  let trailing = "";

  while (url.length > 0) {
    const last = url.at(-1);
    if (!last) break;

    if (TRAILING_PUNCTUATION.has(last)) {
      trailing = last + trailing;
      url = url.slice(0, -1);
      continue;
    }

    const opening = CLOSING_BRACKETS[last];
    if (opening && countChar(url, last) > countChar(url, opening)) {
      trailing = last + trailing;
      url = url.slice(0, -1);
      continue;
    }

    break;
  }

  return { url, trailing };
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function linkifyTextNode(node: MarkdownNode): MarkdownNode[] {
  const value = node.value ?? "";
  const replacements: MarkdownNode[] = [];
  let lastIndex = 0;

  BARE_HTTP_URL_RE.lastIndex = 0;
  for (
    let match = BARE_HTTP_URL_RE.exec(value);
    match;
    match = BARE_HTTP_URL_RE.exec(value)
  ) {
    const rawMatch = match[0];
    const { url, trailing } = splitTrailingUrlPunctuation(rawMatch);
    const safeUrl = safeHttpUrl(url);
    if (!safeUrl) continue;

    if (match.index > lastIndex) {
      replacements.push({
        type: "text",
        value: value.slice(lastIndex, match.index),
      });
    }
    replacements.push({
      type: "link",
      url: safeUrl,
      children: [{ type: "text", value: url }],
    });
    if (trailing) {
      replacements.push({ type: "text", value: trailing });
    }
    lastIndex = match.index + rawMatch.length;
  }

  if (replacements.length === 0) return [node];
  if (lastIndex < value.length) {
    replacements.push({ type: "text", value: value.slice(lastIndex) });
  }
  return replacements;
}

function linkifyBareUrls(node: MarkdownNode): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      nextChildren.push(...linkifyTextNode(child));
      continue;
    }
    linkifyBareUrls(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function remarkLinkBareUrls(): (tree: MarkdownNode) => void {
  return (tree) => linkifyBareUrls(tree);
}

function openExternalUrl(url: string): void {
  try {
    void openUrl(url).catch(() => undefined);
  } catch {
    // Opener errors are not actionable from chat rendering.
  }
}

const MARKDOWN_PREVIEW_SANITIZE_SCHEMA: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "alt",
      "height",
      "title",
      "width",
    ],
  },
};

// eslint-disable-next-line react-refresh/only-export-components -- remark plugin list consumed by ReactMarkdown callers
export const MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  remarkLinkBareUrls,
];

// eslint-disable-next-line react-refresh/only-export-components -- preview-specific raw HTML support for README/GFM rendering
export const MARKDOWN_PREVIEW_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_PREVIEW_SANITIZE_SCHEMA],
];

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

// eslint-disable-next-line react-refresh/only-export-components -- chat-specific adapter map for react-markdown; not a component module
export const CHAT_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  a({
    children,
    href,
    node,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
    void node;
    const safeHref = safeHttpUrl(href);
    if (!safeHref) return <span>{children}</span>;

    return (
      <a
        {...rest}
        href={safeHref}
        rel="noopener noreferrer"
        target="_blank"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openExternalUrl(safeHref);
        }}
      >
        {children}
      </a>
    );
  },
};

// eslint-disable-next-line react-refresh/only-export-components -- shared ReactMarkdown props for chat rendering
export const CHAT_MARKDOWN_PROPS = {
  components: CHAT_MARKDOWN_COMPONENTS,
  remarkPlugins: MARKDOWN_REMARK_PLUGINS,
} satisfies Pick<ReactMarkdownOptions, "components" | "remarkPlugins">;

// eslint-disable-next-line react-refresh/only-export-components -- shared ReactMarkdown props for editor README previews
export const MARKDOWN_PREVIEW_PROPS = {
  components: MARKDOWN_COMPONENTS,
  remarkPlugins: MARKDOWN_REMARK_PLUGINS,
  rehypePlugins: MARKDOWN_PREVIEW_REHYPE_PLUGINS,
} satisfies Pick<
  ReactMarkdownOptions,
  "components" | "remarkPlugins" | "rehypePlugins"
>;

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
