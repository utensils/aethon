import { Button, Card, Heading, Text } from "aethon";
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

/** A running-session card — title + description come from Card props, and
 *  the body composes nested primitives via `renderChildren`. */
export const SessionCard = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <Card
        component={{
          id: "c-session",
          type: "card",
          props: {
            title: "claude-opus-4-8",
            description: "migrate window-state schema · running 12m 03s",
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Text
              component={{
                id: "c-session-cwd",
                type: "text",
                props: {
                  content: "~/Projects/utensils/aethon · main",
                  variant: "small",
                  color: "var(--text-dim)",
                },
              }}
              state={{}}
              onEvent={noop}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <Button
                component={{
                  id: "c-session-view",
                  type: "button",
                  props: { label: "View", variant: "secondary" },
                }}
                state={{}}
                onEvent={noop}
              />
              <Button
                component={{
                  id: "c-session-stop",
                  type: "button",
                  props: { label: "Stop", variant: "ghost" },
                }}
                state={{}}
                onEvent={noop}
              />
            </div>
          </div>
        )}
      />
    </div>
  </Surface>
);

/** Model-picker cards side by side — the elevated card surface reads as a
 *  distinct pane against the base shell background. */
export const ModelCards = () => (
  <Surface>
    <div style={{ display: "flex", gap: 12, maxWidth: 560 }}>
      <Card
        component={{
          id: "c-model-opus",
          type: "card",
          props: {
            title: "Opus 4.8",
            description: "Deepest reasoning · 1M context",
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <Text
            component={{
              id: "c-model-opus-meta",
              type: "text",
              props: {
                content: "$5 / $25 per Mtok",
                variant: "small",
                color: "var(--text-dim)",
              },
            }}
            state={{}}
            onEvent={noop}
          />
        )}
      />
      <Card
        component={{
          id: "c-model-haiku",
          type: "card",
          props: {
            title: "Haiku 4.5",
            description: "Fast, cheap edits · 200k context",
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <Text
            component={{
              id: "c-model-haiku-meta",
              type: "text",
              props: {
                content: "$1 / $5 per Mtok",
                variant: "small",
                color: "var(--text-dim)",
              },
            }}
            state={{}}
            onEvent={noop}
          />
        )}
      />
    </div>
  </Surface>
);

/** A workspace card with heavier padding, headed by a nested Heading and a
 *  git-meta line — shows a card driven entirely by children. */
export const WorkspaceCard = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <Card
        component={{
          id: "c-workspace",
          type: "card",
          props: { padding: 20 },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Heading
              component={{
                id: "c-workspace-title",
                type: "heading",
                props: { content: "feat/remote-worktrees", level: 3 },
              }}
              state={{}}
              onEvent={noop}
            />
            <Text
              component={{
                id: "c-workspace-meta",
                type: "text",
                props: {
                  content: "worktree · 3 ahead · 0 behind · 2 files changed",
                  variant: "small",
                  color: "var(--text-dim)",
                },
              }}
              state={{}}
              onEvent={noop}
            />
            <Text
              component={{
                id: "c-workspace-ci",
                type: "text",
                props: {
                  content: "CI: 4 passing · checks green",
                  variant: "small",
                },
              }}
              state={{}}
              onEvent={noop}
            />
          </div>
        )}
      />
    </div>
  </Surface>
);

/** Title and description bound from the shared state object via `$ref`
 *  JSON Pointers — the core A2UI data-binding idiom. */
export const StateBound = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <Card
        component={{
          id: "c-bound",
          type: "card",
          props: {
            title: { $ref: "/tab/model" },
            description: { $ref: "/tab/summary" },
          },
        }}
        state={{
          tab: {
            model: "gpt-5.6-sol",
            summary: "review copilot findings · queued",
          },
        }}
        onEvent={noop}
      />
    </div>
  </Surface>
);
