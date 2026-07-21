import { Paragraph } from "aethon";
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

// Running body copy — a realistic multi-sentence explanation as it would
// appear in an onboarding or empty-state panel.
export const RunningText = () => (
  <Surface>
    <div style={{ maxWidth: 560 }}>
      <Paragraph
        component={{
          id: "p-intro",
          type: "paragraph",
          props: {
            content:
              "Aethon runs each coding agent in its own workspace, so a session can hold an isolated git worktree, its own model, and a dedicated terminal without stepping on the others. Switch the active workspace in the sidebar and new tabs follow your selection while existing tabs keep the working directory they were created with.",
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// Two stacked paragraphs — verifies the block flow and bottom margin between
// consecutive paragraphs reads correctly.
export const StackedFlow = () => (
  <Surface>
    <div style={{ maxWidth: 560 }}>
      <Paragraph
        component={{
          id: "p-a",
          type: "paragraph",
          props: {
            content:
              "When a devshell is detected, its environment is applied to both interactive shell tabs and the agent's bash tool from a single source of truth.",
          },
        }}
        state={{}}
        onEvent={noop}
      />
      <Paragraph
        component={{
          id: "p-b",
          type: "paragraph",
          props: {
            content:
              "A cold cache spawns the shell unwrapped while a background resolver warms; the next open in that tab picks up the resolved environment automatically.",
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// State-bound running text — content pulled from a JSON Pointer.
export const BoundNotice = () => (
  <Surface>
    <div style={{ maxWidth: 560 }}>
      <Paragraph
        component={{
          id: "p-bound",
          type: "paragraph",
          props: { content: { $ref: "/update/notes" } },
        }}
        state={{
          update: {
            notes:
              "Version 0.12.0 is ready to install. The update was backed up before staging, and a rollback timer arms on the next launch until the app reports a healthy boot.",
          },
        }}
        onEvent={noop}
      />
    </div>
  </Surface>
);
