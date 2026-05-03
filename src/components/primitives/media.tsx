/**
 * Media A2UI primitives — Image and Icon.
 */

import type { CSSProperties } from "react";
import type {
  BooleanValue,
  NumberValue,
  StringValue,
} from "../../types/a2ui";
import {
  resolveString,
  resolveNumber,
  resolveBoolean,
} from "../../utils/dataBinding";
import type { ComponentProps } from "./shared";

const ICON_GLYPHS: Record<string, string> = {
  add: "+",
  plus: "+",
  remove: "-",
  minus: "-",
  close: "x",
  x: "x",
  check: "✓",
  success: "✓",
  warning: "!",
  error: "!",
  info: "i",
  search: "⌕",
  command: "⌘",
  terminal: "▣",
  settings: "⚙",
  file: "□",
  folder: "▣",
  "chevron-left": "‹",
  "chevron-right": "›",
  "chevron-up": "⌃",
  "chevron-down": "⌄",
  "arrow-left": "←",
  "arrow-right": "→",
  "arrow-up": "↑",
  "arrow-down": "↓",
  spark: "✦",
  star: "★",
};

// Image component — renders a data URL or remote URL with a max-width cap.
// Used by tool result cards (e.g. read tool returning an image) AND by
// chrome (header logo), so the className prop opts out of the default
// figure-style framing when the consumer wants raw, unbordered icon-style
// rendering.
export function Image({ component, state }: ComponentProps) {
  const props = component.props as {
    src: StringValue;
    alt?: StringValue;
    maxWidth?: NumberValue;
    caption?: StringValue;
    className?: string;
  };

  const src = resolveString(props.src, state);
  const alt = props.alt ? resolveString(props.alt, state) : "";
  const maxWidth = props.maxWidth ? resolveNumber(props.maxWidth, state) : 480;
  const caption = props.caption ? resolveString(props.caption, state) : undefined;
  const className = props.className;

  // When a className is provided, defer all styling to CSS so the consumer
  // can size + crop without fighting the default figure styles. Without
  // className, keep the full-width framed look the chat tool cards use.
  const imgStyle: CSSProperties = className
    ? { display: "block" }
    : {
        display: "block",
        maxWidth: `min(${maxWidth}px, 100%)`,
        width: "100%",
        height: "auto",
        borderRadius: "6px",
        border: "1px solid var(--border)",
      };

  return (
    <figure
      className={className ? `a2ui-image ${className}` : "a2ui-image"}
      style={{ margin: 0 }}
    >
      {src && <img src={src} alt={alt} className={className} style={imgStyle} />}
      {caption && (
        <figcaption
          style={{
            fontSize: "0.8125rem",
            color: "var(--text-dim)",
            marginTop: src ? "4px" : 0,
          }}
        >
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

// Icon primitive — lightweight built-in glyph map. Extensions that need a
// full icon pack can register a richer component; this keeps the standard
// primitive dependency-free and stable in release builds.
export function Icon({ component, state }: ComponentProps) {
  const props = component.props as {
    name?: StringValue;
    symbol?: StringValue;
    label?: StringValue;
    size?: NumberValue;
    color?: StringValue;
    decorative?: BooleanValue;
  };
  const name = props.name ? resolveString(props.name, state).trim() : "";
  const symbol = props.symbol ? resolveString(props.symbol, state) : "";
  const label = props.label ? resolveString(props.label, state) : name;
  const size = props.size ? resolveNumber(props.size, state) : 16;
  const color = props.color ? resolveString(props.color, state) : "currentColor";
  const decorative = props.decorative
    ? resolveBoolean(props.decorative, state)
    : !label;
  const glyph =
    symbol ||
    ICON_GLYPHS[name.toLowerCase()] ||
    (name ? name.slice(0, 1).toUpperCase() : "•");
  return (
    <span
      className="a2ui-icon"
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      title={decorative ? undefined : label}
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: `${size}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        color,
        fontSize: `${size}px`,
        lineHeight: 1,
        fontWeight: 700,
        fontFamily: "var(--font-ui)",
      }}
    >
      {glyph}
    </span>
  );
}
