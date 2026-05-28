/**
 * Text A2UI primitives — Text, Heading, Paragraph, Code, Divider.
 */

import type { CSSProperties } from "react";
import type { BooleanValue, StringValue } from "../../types/a2ui";
import { resolveBoolean, resolveString } from "../../utils/dataBinding";
import { HighlightedCode } from "../HighlightedCode";
import type { ComponentProps } from "./shared";

// Text component — variants map to the semantic typography roles defined
// in src/styles/tokens.css so themes can tune type personality (size,
// line-height, weight, tracking) without re-templating every component.
//   body  → --type-body-*
//   small → --type-caption-*
//   large → --type-title-*
export function Text({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    variant?: "body" | "small" | "large";
    color?: string;
  };

  const content = resolveString(props.content, state);
  const variant = props.variant || "body";
  const color = props.color;

  const role = variant === "small" ? "caption" : variant === "large" ? "title" : "body";
  const style: CSSProperties = {
    color: color || "inherit",
    fontSize: `var(--type-${role}-size)`,
    lineHeight: `var(--type-${role}-line)`,
    fontWeight: `var(--type-${role}-weight)`,
    letterSpacing: `var(--type-${role}-tracking)`,
  };

  return <span style={style}>{content}</span>;
}

// Code component — Prism-tokenized highlighter that drives every token
// color from CSS custom properties (--syntax-keyword, --syntax-string, …).
// Each palette wires its own values, so re-skinning highlighting is just a
// matter of registering a new theme. Extensions that want a different
// engine entirely (shiki, highlight.js, …) can register a higher-level
// component and route their layouts at it instead of the primitive.
export function Code({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    language?: string;
    showLineNumbers?: BooleanValue;
  };

  const content = resolveString(props.content, state);
  const language = props.language;
  const showLineNumbers = props.showLineNumbers
    ? resolveBoolean(props.showLineNumbers, state)
    : false;

  return (
    <HighlightedCode
      code={content}
      language={language}
      showLineNumbers={showLineNumbers}
    />
  );
}

// Heading primitive — wraps an h1/h2/h3 according to `level` prop.
// h1/h2 use the display role; h3-h6 use the title role. The browser's
// default heading sizes are overridden by the role tokens so themes
// control the rhythm.
export function Heading({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    level?: 1 | 2 | 3 | 4 | 5 | 6;
  };
  const content = resolveString(props.content, state);
  const level = props.level && props.level >= 1 && props.level <= 6 ? props.level : 2;
  const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
  const role = level <= 2 ? "display" : "title";
  const style: CSSProperties = {
    margin: 0,
    fontSize: `var(--type-${role}-size)`,
    lineHeight: `var(--type-${role}-line)`,
    fontWeight: `var(--type-${role}-weight)`,
    letterSpacing: `var(--type-${role}-tracking)`,
  };
  return <Tag style={style}>{content}</Tag>;
}

// Paragraph primitive — text with default block flow. Reads the body
// typography role so theme-level adjustments to running text flow here.
export function Paragraph({ component, state }: ComponentProps) {
  const props = component.props as { content: StringValue };
  const content = resolveString(props.content, state);
  const style: CSSProperties = {
    margin: "0 0 8px 0",
    fontSize: "var(--type-body-size)",
    lineHeight: "var(--type-body-line)",
    fontWeight: "var(--type-body-weight)",
    letterSpacing: "var(--type-body-tracking)",
  };
  return <p style={style}>{content}</p>;
}

// Divider primitive — thin horizontal rule.
export function Divider({ component }: ComponentProps) {
  const props = component.props as
    | { orientation?: "horizontal" | "vertical" }
    | undefined;
  const vertical = props?.orientation === "vertical";
  const style: CSSProperties = vertical
    ? {
        width: 1,
        alignSelf: "stretch",
        background: "var(--border)",
        margin: "0 8px",
      }
    : {
        height: 1,
        width: "100%",
        background: "var(--border)",
        margin: "8px 0",
        border: "none",
      };
  return vertical ? <span style={style} aria-hidden /> : <hr style={style} />;
}
