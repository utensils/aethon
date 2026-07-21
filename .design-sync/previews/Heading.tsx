import { Heading } from "aethon";
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

// Full hierarchy — levels 1 through 4 stacked so the display→title role
// transition (h1/h2 display, h3+ title) is visible in one card.
export const Hierarchy = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      <Heading
        component={{ id: "h1", type: "heading", props: { content: "Sessions", level: 1 } }}
        state={{}}
        onEvent={noop}
      />
      <Heading
        component={{ id: "h2", type: "heading", props: { content: "Active workspace", level: 2 } }}
        state={{}}
        onEvent={noop}
      />
      <Heading
        component={{ id: "h3", type: "heading", props: { content: "Git worktrees", level: 3 } }}
        state={{}}
        onEvent={noop}
      />
      <Heading
        component={{ id: "h4", type: "heading", props: { content: "Uncommitted changes", level: 4 } }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// A settings-panel section header — the common single-level use.
export const PanelSection = () => (
  <Surface>
    <div style={{ maxWidth: 560 }}>
      <Heading
        component={{
          id: "h-settings",
          type: "heading",
          props: { content: "Nix devshell", level: 2 },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

// Title-role heading as it reads above a canvas panel.
export const CanvasTitle = () => (
  <Surface>
    <div style={{ maxWidth: 560 }}>
      <Heading
        component={{
          id: "h-canvas",
          type: "heading",
          props: { content: "Terminal · agent-bash", level: 3 },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);
