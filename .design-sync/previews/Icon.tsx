import { Icon } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the app shell styles `body` with
 *  --bg/--text/--font-ui (chrome base.css), and real designs inherit that
 *  via the styles.css closure — the DS preview harness overrides body to
 *  white, so cards re-create the shell surface locally. */
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

const noop = () => {};

const IconGlyph = ({
  name,
  size = 20,
  color,
  label,
}: {
  name: string;
  size?: number;
  color?: string;
  label?: string;
}) => (
  <Icon
    component={{
      id: `i-${name}-${size}`,
      type: "icon",
      props: { name, size, ...(color ? { color } : {}), ...(label ? { label } : {}) },
    }}
    state={{}}
    onEvent={noop}
  />
);

/** The built-in glyph set as it reads in a toolbar — the icons the chat
 *  composer, command palette, and status bar draw from. */
export const ToolbarGlyphs = () => (
  <Surface>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "10px 14px",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <IconGlyph name="command" label="Command palette" />
      <IconGlyph name="search" label="Search" />
      <IconGlyph name="terminal" label="Terminal" />
      <IconGlyph name="file" label="Files" />
      <IconGlyph name="settings" label="Settings" />
      <IconGlyph name="spark" label="Agent" />
    </div>
  </Surface>
);

/** The same glyph rendered at the app's three canonical sizes — 16 for
 *  dense list rows, 20 for toolbars, 24 for prominent affordances. */
export const SizeScale = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      {[16, 20, 24].map((size) => (
        <div
          key={size}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
        >
          <IconGlyph name="terminal" size={size} label={`Terminal ${size}px`} />
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{size}px</span>
        </div>
      ))}
    </div>
  </Surface>
);

/** Status glyphs tinted with semantic colors — accent for spark, plus the
 *  raw success/warning/error tones a git or CI rollup would surface. */
export const StatusTones = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <IconGlyph name="spark" size={24} color="var(--accent)" label="Agent active" />
      <IconGlyph name="check" size={24} color="#4ec9a0" label="Checks passing" />
      <IconGlyph name="warning" size={24} color="#e0af68" label="Uncommitted changes" />
      <IconGlyph name="x" size={24} color="#f7768e" label="Build failed" />
    </div>
  </Surface>
);

/** Icon name bound from the shared state object via a `$ref` JSON Pointer —
 *  the glyph tracks whatever the state slice points at. */
export const StateBound = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Icon
        component={{
          id: "i-bound",
          type: "icon",
          props: {
            name: { $ref: "/vcs/statusIcon" },
            size: 20,
            color: "var(--accent)",
            label: { $ref: "/vcs/statusLabel" },
          },
        }}
        state={{ vcs: { statusIcon: "check", statusLabel: "Working tree clean" } }}
        onEvent={noop}
      />
      <span style={{ fontSize: "0.875rem", color: "var(--text-dim)" }}>
        Working tree clean
      </span>
    </div>
  </Surface>
);
