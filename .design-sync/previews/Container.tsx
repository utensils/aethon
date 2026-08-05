import { Button, Card, Container, Text } from "aethon";
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

/** Row direction with a gap and centered alignment — a composer toolbar of
 *  actions laid out horizontally. */
export const RowToolbar = () => (
  <Surface>
    <div style={{ maxWidth: 520 }}>
      <Container
        component={{
          id: "ct-row",
          type: "container",
          props: { direction: "row", gap: 8, align: "center", padding: 8 },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <>
            <Button
              component={{
                id: "ct-row-run",
                type: "button",
                props: { label: "Run", variant: "primary" },
              }}
              state={{}}
              onEvent={noop}
            />
            <Button
              component={{
                id: "ct-row-plan",
                type: "button",
                props: { label: "Plan", variant: "secondary" },
              }}
              state={{}}
              onEvent={noop}
            />
            <Button
              component={{
                id: "ct-row-clear",
                type: "button",
                props: { label: "Clear", variant: "ghost" },
              }}
              state={{}}
              onEvent={noop}
            />
          </>
        )}
      />
    </div>
  </Surface>
);

/** Column direction stacking cards with a gap — the vertical rhythm a
 *  sidebar session list relies on. */
export const ColumnStack = () => (
  <Surface>
    <div style={{ maxWidth: 340 }}>
      <Container
        component={{
          id: "ct-col",
          type: "container",
          props: { direction: "column", gap: 10 },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <>
            <Card
              component={{
                id: "ct-col-a",
                type: "card",
                props: {
                  title: "fix flaky scrollSpy test",
                  description: "claude-sonnet-5 · completed 4m 12s",
                },
              }}
              state={{}}
              onEvent={noop}
            />
            <Card
              component={{
                id: "ct-col-b",
                type: "card",
                props: {
                  title: "voice hotkey regression",
                  description: "gpt-5.6-sol · queued",
                },
              }}
              state={{}}
              onEvent={noop}
            />
          </>
        )}
      />
    </div>
  </Surface>
);

/** Row with `justify: space-between` — a status-bar-style header that
 *  pushes the label and meta to opposite edges. */
export const SpaceBetween = () => (
  <Surface>
    <div style={{ maxWidth: 520 }}>
      <Container
        component={{
          id: "ct-between",
          type: "container",
          props: {
            direction: "row",
            justify: "space-between",
            align: "center",
            padding: 12,
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <>
            <Text
              component={{
                id: "ct-between-left",
                type: "text",
                props: { content: "aethon · main", variant: "body" },
              }}
              state={{}}
              onEvent={noop}
            />
            <Text
              component={{
                id: "ct-between-right",
                type: "text",
                props: {
                  content: "⬡ flake · 3 agents active",
                  variant: "small",
                  color: "var(--text-dim)",
                },
              }}
              state={{}}
              onEvent={noop}
            />
          </>
        )}
      />
    </div>
  </Surface>
);
