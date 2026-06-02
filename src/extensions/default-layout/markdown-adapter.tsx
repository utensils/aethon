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
import { Children, isValidElement, useEffect, useId, useState } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as RehypeSanitizeOptions,
} from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { defaultUrlTransform } from "react-markdown";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import type { Element as HastElement } from "hast";
import { HighlightedCode } from "../../components/HighlightedCode";

type MarkdownRemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
type MarkdownRehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

type CodeElementProps = {
  className?: string;
  children?: React.ReactNode;
};

type HastElementNode = {
  tagName?: string;
  properties?: {
    className?: string | string[];
  };
  children?: HastElementNode[];
  value?: string;
};

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

function safeDataImageUrl(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (
    !/^data:image\/(?:apng|avif|bmp|gif|jpe?g|png|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)(?:;[a-z0-9.+-]+=[^;,]+)*;base64,[a-z0-9+/=]+$/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  return trimmed;
}

// eslint-disable-next-line react-refresh/only-export-components -- shared by preview image renderers
export function safeMarkdownImageSrc(value: string | undefined): string | null {
  return safeHttpUrl(value) ?? safeDataImageUrl(value);
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
  protocols: {
    ...defaultSchema.protocols,
    src: Array.from(new Set([...(defaultSchema.protocols?.src ?? []), "data"])),
  },
};

function markdownPreviewUrlTransform(
  value: string,
  key: string,
  node: Readonly<HastElement>,
): string | null | undefined {
  if (key === "src" && node.tagName === "img") {
    const safeImageSrc = safeMarkdownImageSrc(value);
    if (safeImageSrc) return safeImageSrc;
  }
  return defaultUrlTransform(value);
}

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
  const child = Children.toArray(node)[0];
  if (!isValidElement<{ "data-highlighted-fence"?: boolean }>(child)) {
    return false;
  }
  return child.props?.["data-highlighted-fence"] === true;
}

function codeChildFromPre(
  node: React.ReactNode,
): React.ReactElement<CodeElementProps> | null {
  const children = Children.toArray(node);
  if (children.length !== 1) return null;
  const child = children[0];
  if (!isValidElement<CodeElementProps>(child)) return null;
  return child.type === "code" ? child : null;
}

function languageFromClassName(
  className: string | undefined,
): string | undefined {
  return /language-([\w+-]+)/.exec(className ?? "")?.[1];
}

function classNameFromHast(
  node: HastElementNode | undefined,
): string | undefined {
  const className = node?.properties?.className;
  return Array.isArray(className) ? className.join(" ") : className;
}

function textFromHast(node: HastElementNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => textFromHast(child)).join("");
}

function createMarkdownComponents({
  highlightFences = true,
  renderMermaid,
}: {
  highlightFences?: boolean;
  renderMermaid: boolean;
}) {
  const renderFence = (code: string, language?: string) =>
    highlightFences ? (
      <HighlightedFence code={code} language={language} />
    ) : (
      <PlainFence code={code} language={language} />
    );

  return {
    pre({
      children,
      node,
      ...rest
    }: React.HTMLAttributes<HTMLPreElement> & { node?: HastElementNode }) {
      if (isHighlightedFenceChild(children)) {
        return <>{children}</>;
      }
      const hastCodeChild =
        node?.children?.length === 1 && node.children[0]?.tagName === "code"
          ? node.children[0]
          : undefined;
      if (hastCodeChild) {
        const code = textFromHast(hastCodeChild).replace(/\n$/, "");
        const language = languageFromClassName(
          classNameFromHast(hastCodeChild),
        );
        if (renderMermaid && language?.toLowerCase() === "mermaid") {
          return <MermaidDiagram code={code} />;
        }
        return renderFence(code, language);
      }
      const codeChild = codeChildFromPre(children);
      if (codeChild) {
        const text = String(codeChild.props.children ?? "").replace(/\n$/, "");
        const language = languageFromClassName(codeChild.props.className);
        if (renderMermaid && language?.toLowerCase() === "mermaid") {
          return <MermaidDiagram code={text} />;
        }
        return renderFence(text, language);
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
      const language = languageFromClassName(className);
      const isFence = inline === false || Boolean(language);
      if (!isFence) {
        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      }
      if (renderMermaid && language?.toLowerCase() === "mermaid") {
        return <MermaidDiagram code={text} />;
      }
      return renderFence(text, language);
    },
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- adapter map for react-markdown; not a component module
export const MARKDOWN_COMPONENTS = createMarkdownComponents({
  renderMermaid: false,
});

const MARKDOWN_PREVIEW_COMPONENTS = createMarkdownComponents({
  renderMermaid: true,
});

function ChatAnchor({
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
}

// eslint-disable-next-line react-refresh/only-export-components -- chat-specific adapter map for react-markdown; not a component module
export const CHAT_MARKDOWN_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  a: ChatAnchor,
};

// eslint-disable-next-line react-refresh/only-export-components -- shared ReactMarkdown props for chat rendering
export const CHAT_MARKDOWN_PROPS = {
  components: CHAT_MARKDOWN_COMPONENTS,
  remarkPlugins: MARKDOWN_REMARK_PLUGINS,
} satisfies Pick<ReactMarkdownOptions, "components" | "remarkPlugins">;

const CHAT_STREAMING_MARKDOWN_COMPONENTS = {
  ...createMarkdownComponents({
    highlightFences: false,
    renderMermaid: false,
  }),
  a: ChatAnchor,
};

// eslint-disable-next-line react-refresh/only-export-components -- shared ReactMarkdown props for active streaming code blocks
export const CHAT_STREAMING_MARKDOWN_PROPS = {
  components: CHAT_STREAMING_MARKDOWN_COMPONENTS,
  remarkPlugins: MARKDOWN_REMARK_PLUGINS,
} satisfies Pick<ReactMarkdownOptions, "components" | "remarkPlugins">;

// eslint-disable-next-line react-refresh/only-export-components -- shared ReactMarkdown props for editor README previews
export const MARKDOWN_PREVIEW_PROPS = {
  components: MARKDOWN_PREVIEW_COMPONENTS,
  remarkPlugins: MARKDOWN_REMARK_PLUGINS,
  rehypePlugins: MARKDOWN_PREVIEW_REHYPE_PLUGINS,
  urlTransform: markdownPreviewUrlTransform,
} satisfies Pick<
  ReactMarkdownOptions,
  "components" | "remarkPlugins" | "rehypePlugins" | "urlTransform"
>;

// Wrapper that tags the rendered element with a data attribute so the
// `pre` override above can detect "this is our fenced output" and
// unwrap the outer markdown `<pre>`.
export function HighlightedFence({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  return (
    <div data-highlighted-fence>
      <HighlightedCode code={code} language={language} />
    </div>
  );
}

export function PlainFence({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const text = code.endsWith("\n") ? code.slice(0, -1) : code;
  const lang = (language ?? "").toLowerCase();
  const displayLang = lang || "text";
  return (
    <div data-highlighted-fence>
      <div className="a2ui-code-frame" data-language={lang || "plain"}>
        <div className="a2ui-code-header">
          <span className="a2ui-code-title">{displayLang}</span>
        </div>
        <pre className="a2ui-code" data-language={lang || "plain"}>
          <code>{text}</code>
        </pre>
      </div>
    </div>
  );
}

function sanitizeMermaidSvg(svg: string): string {
  if (
    typeof DOMParser === "undefined" ||
    typeof XMLSerializer === "undefined"
  ) {
    return svg;
  }
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("mermaid returned invalid SVG");
  }
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== "svg") {
    throw new Error("mermaid returned non-SVG content");
  }
  for (const unsafe of Array.from(
    doc.querySelectorAll("script, foreignObject"),
  )) {
    unsafe.remove();
  }
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId();
  const diagramId = `aethon-mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [renderResult, setRenderResult] = useState<{
    code: string;
    failed: boolean;
    svg: string;
  }>({ code: "", failed: false, svg: "" });

  useEffect(() => {
    let cancelled = false;
    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "default",
        });
        return mermaid.render(diagramId, code);
      })
      .then(({ svg: renderedSvg }) => {
        if (cancelled) return;
        setRenderResult({
          code,
          failed: false,
          svg: sanitizeMermaidSvg(renderedSvg),
        });
      })
      .catch(() => {
        if (!cancelled) setRenderResult({ code, failed: true, svg: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  const svg = renderResult.code === code ? renderResult.svg : "";
  const failed = renderResult.code === code ? renderResult.failed : false;

  return (
    <div data-highlighted-fence>
      {svg && !failed ? (
        <div className="a2ui-mermaid-frame">
          <div className="a2ui-mermaid-header">mermaid</div>
          <div
            className="a2ui-mermaid-diagram"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      ) : (
        <HighlightedCode code={code} language="mermaid" />
      )}
    </div>
  );
}
