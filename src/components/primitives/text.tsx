/**
 * Text A2UI primitives — Text, Heading, Paragraph, Code, Divider.
 */

import type { CSSProperties } from "react";
import type { BooleanValue, StringValue } from "../../types/a2ui";
import { resolveBoolean, resolveString } from "../../utils/dataBinding";
import { HighlightedCode } from "../HighlightedCode";
import type { ComponentProps } from "./shared";

// Text component
export function Text({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    variant?: "body" | "small" | "large";
    color?: string;
  };

  const content = resolveString(props.content, state);
  const variant = props.variant || "body";
  const color = props.color;

  const style: CSSProperties = {
    color: color || "inherit",
    fontSize:
      variant === "small" ? "0.875rem" : variant === "large" ? "1.125rem" : "1rem",
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
export function Heading({ component, state }: ComponentProps) {
  const props = component.props as {
    content: StringValue;
    level?: 1 | 2 | 3 | 4 | 5 | 6;
  };
  const content = resolveString(props.content, state);
  const level = props.level && props.level >= 1 && props.level <= 6 ? props.level : 2;
  const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
  return <Tag style={{ margin: 0 }}>{content}</Tag>;
}

// Paragraph primitive — text with default block flow.
export function Paragraph({ component, state }: ComponentProps) {
  const props = component.props as { content: StringValue };
  const content = resolveString(props.content, state);
  return <p style={{ margin: "0 0 8px 0", lineHeight: 1.5 }}>{content}</p>;
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
