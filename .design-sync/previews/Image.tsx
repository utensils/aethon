import { Image } from "aethon";
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

/** External hosts are blocked by the product CSP, so previews (like real
 *  tool-result cards) draw with inline SVG data URIs. */
const svg = (markup: string) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(markup);

// A terminal-window screenshot as a tool-result card might return it.
const terminalShot = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" rx="10" fill="#141110"/>
  <rect x="0" y="0" width="640" height="34" rx="10" fill="#1d1a18"/>
  <circle cx="20" cy="17" r="6" fill="#f7768e"/>
  <circle cx="42" cy="17" r="6" fill="#e0af68"/>
  <circle cx="64" cy="17" r="6" fill="#4ec9a0"/>
  <text x="320" y="21" fill="#8a8178" font-family="monospace" font-size="13" text-anchor="middle">aethon — main</text>
  <g font-family="monospace" font-size="14">
    <text x="22" y="74" fill="#e6842a">$</text>
    <text x="42" y="74" fill="#d8d2cb">cargo tauri dev</text>
    <text x="22" y="104" fill="#4ec9a0">   Compiling</text>
    <text x="140" y="104" fill="#d8d2cb">aethon v0.12.0</text>
    <text x="22" y="134" fill="#4ec9a0">    Finished</text>
    <text x="130" y="134" fill="#d8d2cb">dev profile in 8.42s</text>
    <text x="22" y="164" fill="#7aa2f7">   info</text>
    <text x="90" y="164" fill="#d8d2cb">bridge ready · 3 tabs restored</text>
    <text x="22" y="200" fill="#e6842a">$</text>
    <rect x="42" y="188" width="9" height="16" fill="#e6842a"/>
  </g>
</svg>`);

// A token-usage sparkline chart placeholder for a session summary.
const usageChart = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">
  <rect width="480" height="200" rx="8" fill="#1d1a18"/>
  <line x1="40" y1="30" x2="40" y2="164" stroke="#3a352f" stroke-width="1"/>
  <line x1="40" y1="164" x2="452" y2="164" stroke="#3a352f" stroke-width="1"/>
  <polyline fill="none" stroke="#e6842a" stroke-width="2.5"
    points="40,150 100,120 160,132 220,88 280,96 340,54 400,66 452,38"/>
  <polygon fill="#e6842a" opacity="0.14"
    points="40,150 100,120 160,132 220,88 280,96 340,54 400,66 452,38 452,164 40,164"/>
  <text x="46" y="24" fill="#8a8178" font-family="sans-serif" font-size="12">tokens / turn</text>
</svg>`);

// An agent identity avatar chip.
const agentAvatar = svg(`
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="20" fill="#1d1a18"/>
  <circle cx="48" cy="48" r="26" fill="none" stroke="#e6842a" stroke-width="3"/>
  <path d="M48 30 l5 12 12 0 -9.5 8 4 12 -11.5 -7.5 -11.5 7.5 4 -12 -9.5 -8 12 0 z" fill="#e6842a"/>
</svg>`);

/** A tool-result screenshot at the framed default width, with a caption —
 *  how the chat renders an image returned by the agent's read/shell tools. */
export const ToolResult = () => (
  <Surface>
    <div style={{ maxWidth: 480 }}>
      <Image
        component={{
          id: "img-terminal",
          type: "image",
          props: {
            src: terminalShot,
            alt: "Terminal output from cargo tauri dev",
            maxWidth: 440,
            caption: "shell://main · cargo tauri dev — exit 0",
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** A narrower embedded chart with a caption — token usage for a session,
 *  capped by maxWidth so it sits inline in a summary card. */
export const UsageChart = () => (
  <Surface>
    <div style={{ maxWidth: 360 }}>
      <Image
        component={{
          id: "img-usage",
          type: "image",
          props: {
            src: usageChart,
            alt: "Token usage per turn, trending up",
            maxWidth: 340,
            caption: "opus-4-8 · 214k tokens across 8 turns",
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** Two agent-avatar chips side by side — small framed images sitting inline
 *  as identity markers on a session row. */
export const AvatarRow = () => (
  <Surface>
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <div style={{ width: 72 }}>
        <Image
          component={{
            id: "img-avatar-a",
            type: "image",
            props: { src: agentAvatar, alt: "Reviewer agent", maxWidth: 72 },
          }}
          state={{}}
          onEvent={noop}
        />
      </div>
      <div>
        <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>Reviewer</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
          gpt-5.6-sol · idle
        </div>
      </div>
    </div>
  </Surface>
);

/** Image `src` bound from the shared state object via a `$ref` JSON Pointer —
 *  the rendered figure tracks whatever data URI the state slice points at. */
export const StateBound = () => (
  <Surface>
    <div style={{ maxWidth: 360 }}>
      <Image
        component={{
          id: "img-bound",
          type: "image",
          props: {
            src: { $ref: "/preview/chart" },
            alt: "Bound usage chart",
            maxWidth: 340,
            caption: { $ref: "/preview/caption" },
          },
        }}
        state={{
          preview: {
            chart: usageChart,
            caption: "bound from /preview/chart",
          },
        }}
        onEvent={noop}
      />
    </div>
  </Surface>
);
