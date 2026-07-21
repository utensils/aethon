import { List } from "aethon";
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

const sessions = [
  "fix flaky scrollSpy test",
  "migrate window-state schema",
  "voice hotkey regression",
  "release 0.12.1 notes",
];

/** An unordered list of active session names — the default `ul` semantics
 *  the primitive ships with, items passed inline as strings. */
export const SessionList = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <List
        component={{
          id: "l-sessions",
          type: "list",
          props: { items: sessions },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** An ordered list — the agent's numbered task queue, `ordered: true`
 *  switching the primitive to `ol` numbering. */
export const TaskQueue = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <List
        component={{
          id: "l-queue",
          type: "list",
          props: {
            ordered: true,
            items: [
              "Resolve merge conflict on main",
              "Rebase feat/remote-worktrees",
              "Run check gate (clippy + tsc + vitest)",
              "Open release PR",
            ],
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** Per-item child templates: each object item expands the `children`
 *  template with `/$item` and `/$index` in scope, so a list row can render
 *  a rich composite instead of plain text. The DS harness supplies the
 *  scoped `renderChildWithState` the A2UIRenderer passes at runtime. */
export const TemplatedRows = () => {
  const rows = [
    { name: "opus-4-8", detail: "migrate window-state schema", status: "running" },
    { name: "sonnet-5", detail: "fix flaky scrollSpy test", status: "done" },
    { name: "gpt-5.6-sol", detail: "voice hotkey regression", status: "queued" },
  ];
  const tone: Record<string, string> = {
    running: "#e6842a",
    done: "#4ec9a0",
    queued: "#8a8178",
  };
  const renderChildWithState = (
    _child: unknown,
    overlay: Record<string, unknown>,
  ) => {
    const item = overlay.$item as { name: string; detail: string; status: string };
    return (
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          padding: "4px 0",
        }}
      >
        <span>
          <span style={{ fontWeight: 600 }}>{item.name}</span>
          <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: "0.85rem" }}>
            {item.detail}
          </span>
        </span>
        <span
          style={{
            color: tone[item.status] ?? "var(--text-dim)",
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {item.status}
        </span>
      </div>
    );
  };
  return (
    <Surface>
      <div style={{ maxWidth: 420 }}>
        <List
          component={{
            id: "l-templated",
            type: "list",
            props: { items: rows },
            children: [{ id: "l-templated-row", type: "container", props: {} }],
          }}
          state={{}}
          onEvent={noop}
          renderChildWithState={renderChildWithState}
        />
      </div>
    </Surface>
  );
};

/** Items bound from the shared state object via a `$ref` JSON Pointer — the
 *  list re-renders whenever the pointed-at array changes. */
export const StateBound = () => (
  <Surface>
    <div style={{ maxWidth: 380 }}>
      <List
        component={{
          id: "l-bound",
          type: "list",
          props: { items: { $ref: "/workspace/recentBranches" } },
        }}
        state={{
          workspace: {
            recentBranches: [
              "main",
              "feat/remote-worktrees",
              "fix/mobile-scale",
              "chore/release-0.12.0",
            ],
          },
        }}
        onEvent={noop}
      />
    </div>
  </Surface>
);
