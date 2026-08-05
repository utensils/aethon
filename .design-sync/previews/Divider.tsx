import { Divider, Heading, Text } from "aethon";
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

/** Horizontal rule separating two stacked settings groups — the default
 *  orientation, a full-width hairline in the border token. */
export const Horizontal = () => (
  <Surface>
    <div style={{ maxWidth: 420 }}>
      <Heading
        component={{
          id: "d-h-title",
          type: "heading",
          props: { content: "Agent", level: 3 },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "d-h-a",
          type: "text",
          props: {
            content: "Idle workers retire after 15 minutes.",
            variant: "small",
            color: "var(--text-dim)",
          },
        }}
        state={{}}
        onEvent={noop}
      />
      <Divider
        component={{ id: "d-h-rule", type: "divider", props: {} }}
        state={{}}
        onEvent={noop}
      />
      <Heading
        component={{
          id: "d-h-title2",
          type: "heading",
          props: { content: "Nix devshell", level: 3 },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "d-h-b",
          type: "text",
          props: {
            content: "Wrap shell tabs and the agent bash tool in the flake env.",
            variant: "small",
            color: "var(--text-dim)",
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** Vertical divider between inline status items — needs an explicit height
 *  container since it stretches to its parent, so it sits in a fixed-height
 *  flex row. */
export const Vertical = () => (
  <Surface>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 28,
        maxWidth: 520,
      }}
    >
      <Text
        component={{
          id: "d-v-branch",
          type: "text",
          props: { content: "main", variant: "small" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Divider
        component={{
          id: "d-v-1",
          type: "divider",
          props: { orientation: "vertical" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "d-v-ahead",
          type: "text",
          props: { content: "3 ahead", variant: "small" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Divider
        component={{
          id: "d-v-2",
          type: "divider",
          props: { orientation: "vertical" },
        }}
        state={{}}
        onEvent={noop}
      />
      <Text
        component={{
          id: "d-v-ci",
          type: "text",
          props: { content: "CI green", variant: "small" },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);
