import { Text } from "aethon";
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

// Variant axis sweep — the three semantic typography roles side by side,
// as they read in Aethon's session chrome.
export const VariantScale = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 480 }}>
      <Text
        component={{
          id: "t-large",
          type: "text",
          props: { content: "Workspace: aethon / feat-voice-cascade", variant: "large" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "t-body",
          type: "text",
          props: {
            content: "Claude Opus 4.8 is streaming a response in the active session.",
            variant: "body",
          },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "t-small",
          type: "text",
          props: { content: "Last synced 2 minutes ago · 14 files changed", variant: "small" },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// Core A2UI idiom — content bound to state via a $ref JSON Pointer, plus an
// explicit color for a status accent.
export const StateBoundStatus = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 480 }}>
      <Text
        component={{
          id: "t-branch",
          type: "text",
          props: { content: { $ref: "/vcs/branch" }, variant: "body" },
        }}
        state={{ vcs: { branch: "main ↑2 ↓0" } }}
        onEvent={noop}
      />
      <Text
        component={{
          id: "t-ci",
          type: "text",
          props: { content: { $ref: "/vcs/ci" }, variant: "small", color: "var(--success, #3fb950)" },
        }}
        state={{ vcs: { ci: "CI passing · 6/6 checks green" } }}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// Inline label + value composition, the way status-bar chips read.
export const InlineMeta = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <Text
        component={{
          id: "t-label",
          type: "text",
          props: { content: "Model", variant: "small", color: "var(--text-muted, #8b949e)" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "t-value",
          type: "text",
          props: { content: "claude-opus-4-8 · thinking: medium", variant: "body" },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);
