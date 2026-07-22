import { Chevron } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the DS preview harness forces a white card
 *  body, but Chevron strokes with `currentColor` — so we re-create the app
 *  shell's dark surface locally and set `color: var(--text)` so the glyph is
 *  visible (on white it would render effectively blank at 14px). */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      padding: 16,
      borderRadius: 8,
    }}
  >
    {children}
  </div>
);

const caption: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-dim)",
};

/** The glyph in both disclosure states across the sizes it ships at —
 *  14px (default), 20px, 28px — each cell labelled so the rotation reads. */
export const StatesAndSizes = () => (
  <Surface>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      {([14, 20, 28] as const).map((size) => (
        <div
          key={size}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            alignItems: "center",
          }}
        >
          <span style={caption}>{size}px</span>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}
          >
            <Chevron expanded={false} size={size} />
            <span style={caption}>collapsed</span>
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}
          >
            <Chevron expanded size={size} />
            <span style={caption}>expanded</span>
          </div>
        </div>
      ))}
    </div>
  </Surface>
);

/** Emphasis contrast: the same 20px chevron at full `--text` strength next
 *  to the muted `--text-dim` weight it takes in a resting sidebar row. */
export const Emphasis = () => (
  <Surface>
    <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <Chevron expanded size={20} />
        <span style={caption}>--text</span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "center",
          color: "var(--text-dim)",
        }}
      >
        <Chevron expanded size={20} />
        <span style={caption}>--text-dim</span>
      </div>
    </div>
  </Surface>
);

/** Realistic sidebar composition: chevron leads a tree row, the expanded
 *  parent revealing an indented child. Rows inherit the muted row color and
 *  brighten on the "active" child, exactly as the sidebar tree paints them. */
export const SidebarRows = () => {
  const Row = ({
    expanded,
    label,
    indent = 0,
    active = false,
  }: {
    expanded?: boolean;
    label: string;
    indent?: number;
    active?: boolean;
  }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingLeft: 8 + indent * 16,
        paddingRight: 8,
        borderRadius: 6,
        fontSize: "0.8125rem",
        color: active ? "var(--text)" : "var(--text-dim)",
        background: active ? "var(--bg-hover)" : "transparent",
      }}
    >
      {expanded === undefined ? (
        <span style={{ width: 14, flexShrink: 0 }} />
      ) : (
        <span
          style={{
            display: "inline-flex",
            width: 14,
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Chevron expanded={expanded} size={14} />
        </span>
      )}
      <span>{label}</span>
    </div>
  );

  return (
    <Surface>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 260 }}>
        <Row expanded label="aethon" />
        <Row expanded={false} indent={1} label="src-tauri" />
        <Row expanded indent={1} label="src" />
        <Row indent={2} label="App.tsx" active />
        <Row indent={2} label="main.tsx" />
      </div>
    </Surface>
  );
};
